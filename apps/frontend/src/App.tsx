import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type DrillPayload,
  type GradeResult,
  type Mode,
  type SessionPayload,
} from "./api.ts";
import { useRealtime } from "./useRealtime.ts";

const MODES: { value: Mode; label: string }[] = [
  { value: "mixed", label: "Mixed" },
  { value: "db_indexes", label: "DB indexes" },
  { value: "system_design", label: "System design" },
  { value: "weak_topics", label: "Weak topics" },
  { value: "mock_interview", label: "Mock interview" },
];

export function App() {
  const [mode, setMode] = useState<Mode>("mixed");
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [drill, setDrill] = useState<DrillPayload | null>(null);
  const [transcript, setTranscript] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{
    drills: number;
    openai_configured: boolean;
  } | null>(null);

  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const realtime = useRealtime();

  // Stream realtime transcript into the textarea once captured.
  useEffect(() => {
    if (realtime.transcript) setTranscript(realtime.transcript);
  }, [realtime.transcript]);

  // When a new drill is selected while voice is live, push it to the agent.
  useEffect(() => {
    if (drill && realtime.status === "connected") {
      realtime.pushDrill(drill.question_text);
    }
  }, [drill, realtime.pushDrill, realtime.status]);

  useEffect(() => {
    api
      .health()
      .then((h) =>
        setHealth({
          drills: h.drills,
          openai_configured: h.openai_configured,
        }),
      )
      .catch((e) => setError((e as Error).message));
  }, []);

  const startTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    setElapsed(0);
    setRunning(true);
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = window.setInterval(() => {
      if (startedAtRef.current) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 250);
  }, []);

  const stopTimer = useCallback((): number => {
    setRunning(false);
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    const start = startedAtRef.current ?? Date.now();
    return Math.max(1, Math.round((Date.now() - start) / 1000));
  }, []);

  const onStart = useCallback(async () => {
    setError(null);
    setGrade(null);
    setTranscript("");
    try {
      const s = await api.startSession(mode);
      setSession(s);
      const d = await api.nextDrill(s.id, mode);
      setDrill(d);
      startTimer();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mode, startTimer]);

  const onNext = useCallback(async () => {
    if (!session) return;
    setError(null);
    setGrade(null);
    setTranscript("");
    try {
      const d = await api.nextDrill(session.id, mode);
      setDrill(d);
      startTimer();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mode, session, startTimer]);

  const onSubmit = useCallback(async () => {
    if (!drill) return;
    if (!transcript.trim()) {
      setError("Type or speak an answer first.");
      return;
    }
    setError(null);
    const duration = running ? stopTimer() : Math.max(1, elapsed);
    setGrading(true);
    try {
      const result = await api.grade(drill.attempt_id, transcript, duration);
      setGrade(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGrading(false);
    }
  }, [drill, elapsed, running, stopTimer, transcript]);

  const verdictClass = useMemo(() => {
    if (!grade) return "";
    return `verdict-${grade.verdict}`;
  }, [grade]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>GPT Realtime Interview Drill Coach</h1>
        <div className="status">
          {health
            ? `${health.drills} drills · OpenAI ${
                health.openai_configured ? "ready" : "missing key"
              }`
            : "..."}
        </div>
      </header>

      <section className="panel">
        <h2>Drill</h2>

        {!drill && (
          <>
            <p className="muted">
              Pick a mode and start. The backend's rotation engine selects the
              drill so you don't get the exact same task repeatedly.
            </p>
            <div className="row">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button className="primary" onClick={onStart}>
                Start session
              </button>
            </div>
          </>
        )}

        {drill && (
          <>
            <div className="row" style={{ marginBottom: "0.6rem" }}>
              <span className="tag">{drill.topic}</span>
              <span className="tag">{drill.subtopic}</span>
              <span className="tag">difficulty {drill.difficulty}</span>
              <span className="timer">⏱ {formatTime(elapsed)}</span>
            </div>
            <div className="question">{drill.question_text.trim()}</div>

            <div
              className="row"
              style={{ marginTop: "0.9rem", marginBottom: "0.5rem" }}
            >
              <button
                onClick={() =>
                  realtime.status === "connected"
                    ? realtime.stop()
                    : realtime.start(drill?.question_text)
                }
                disabled={realtime.status === "connecting"}
              >
                {realtime.status === "connected"
                  ? "Stop voice"
                  : realtime.status === "connecting"
                    ? "Connecting..."
                    : "Start voice"}
              </button>
              <button onClick={onSubmit} disabled={grading} className="primary">
                {grading ? "Grading…" : "Submit answer"}
              </button>
              <button onClick={onNext} disabled={grading}>
                Next drill
              </button>
            </div>

            <textarea
              className="transcript"
              placeholder="Speak (voice on) or type your answer here. Press Submit to grade."
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={8}
              style={{
                width: "100%",
                resize: "vertical",
                color: "inherit",
                background: "#0a0c12",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "0.6rem 0.7rem",
                fontFamily: "inherit",
                fontSize: "0.95rem",
              }}
            />
            <audio ref={realtime.audioEl} autoPlay playsInline />
            {realtime.error && (
              <p className="error">voice: {realtime.error}</p>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
      </section>

      <aside className="panel">
        <h2>Grading</h2>
        {!grade && (
          <p className="muted">
            Submit your answer and the backend will grade it rubric-first:
            score, missed points, ideal short answer, and follow-up cards.
          </p>
        )}
        {grade && (
          <>
            <div className="scoreline">
              <span className="score">{Math.round(grade.score * 100)}</span>
              <span className={verdictClass}>{grade.verdict}</span>
            </div>
            <p className="muted" style={{ marginTop: "0.2rem" }}>
              must-have {(grade.breakdown.must_have_coverage * 100).toFixed(0)}% ·
              clarity {(grade.breakdown.answer_clarity * 100).toFixed(0)}% ·
              tradeoffs {(grade.breakdown.tradeoff_coverage * 100).toFixed(0)}% ·
              speed {(grade.breakdown.speed_score * 100).toFixed(0)}%
              {grade.breakdown.red_flag_penalty > 0 &&
                ` · −${(grade.breakdown.red_flag_penalty * 100).toFixed(0)} flags`}
            </p>

            {grade.missed_points.length > 0 && (
              <>
                <h3 style={{ margin: "0.8rem 0 0.2rem", fontSize: "0.95rem" }}>
                  Missed
                </h3>
                <ul className="missed">
                  {grade.missed_points.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </>
            )}

            <h3 style={{ margin: "0.8rem 0 0.2rem", fontSize: "0.95rem" }}>
              Ideal short answer
            </h3>
            <p style={{ margin: 0 }}>{grade.ideal_short_answer}</p>

            {grade.cards.length > 0 && (
              <>
                <h3 style={{ margin: "0.8rem 0 0.4rem", fontSize: "0.95rem" }}>
                  Generated cards
                </h3>
                {grade.cards.map((c, i) => (
                  <div className="card" key={i}>
                    <div className="front">{c.front}</div>
                    <div className="back">{c.back}</div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
