import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type DrillPayload,
  type GradeResult,
  type Mode,
  type SessionPayload,
  type SessionSummary,
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
  const [progress, setProgress] = useState<
    {
      topic: string;
      subtopic: string;
      weakness_score: number;
      exposure_count: number;
    }[]
  >([]);
  const [dueCards, setDueCards] = useState<
    {
      id: string;
      front: string;
      back: string;
      topic: string | null;
      subtopic: string | null;
    }[]
  >([]);
  const [cardStats, setCardStats] = useState<{ total: number; due: number }>({
    total: 0,
    due: 0,
  });
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [drillBrowse, setDrillBrowse] = useState<
    | {
        id: string;
        topic: string;
        subtopic: string;
        difficulty: number;
        trap_type: string | null;
        question_text: string;
        canonical_short_answer: string;
        rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
      }[]
    | null
  >(null);
  const [drillBrowseOpen, setDrillBrowseOpen] = useState(false);
  const [drillBrowseFilter, setDrillBrowseFilter] = useState<string>("");
  const [expandedDrill, setExpandedDrill] = useState<string | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [ending, setEnding] = useState(false);

  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const pushedVoiceDrillRef = useRef<string | null>(null);
  const realtime = useRealtime();

  // Stream realtime transcript into the textarea once captured.
  useEffect(() => {
    if (realtime.transcript) setTranscript(realtime.transcript);
  }, [realtime.transcript]);

  // When a new drill is selected while voice is live, push it to the agent.
  useEffect(() => {
    if (
      drill &&
      realtime.status === "connected" &&
      pushedVoiceDrillRef.current !== drill.attempt_id
    ) {
      realtime.pushDrill(drill.question_text);
      pushedVoiceDrillRef.current = drill.attempt_id;
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

  // Register the Realtime tool handler. When the agent calls a backend
  // tool, we proxy to /api/realtime/tool-call and mirror agent-driven
  // results into local state (so the UI follows the agent's lead).
  useEffect(() => {
    if (!session) {
      realtime.setToolHandler(null);
      return;
    }
    realtime.setToolHandler(async (call) => {
      const result = await api.toolCall(
        session.id,
        call.name,
        call.arguments,
        session.user_id,
      );
      if (call.name === "get_next_drill" && !result.error) {
        const driven: DrillPayload = {
          drill_id: String(result.drill_id ?? ""),
          attempt_id: String(result.attempt_id ?? ""),
          question_text: String(result.question_text ?? ""),
          topic: String(result.topic ?? ""),
          subtopic: String(result.subtopic ?? ""),
          difficulty: Number(result.difficulty ?? 0),
          expected_answer_shape: Array.isArray(result.expected_answer_shape)
            ? (result.expected_answer_shape as string[])
            : [],
          rubric: {
            must_have: Array.isArray(result.expected_answer_shape)
              ? (result.expected_answer_shape as string[])
              : [],
            nice_to_have: [],
            red_flags: [],
          },
        };
        pushedVoiceDrillRef.current = driven.attempt_id;
        setDrill(driven);
        setGrade(null);
        setTranscript("");
        startTimer();
      }
      if (call.name === "grade_attempt" && !result.error) {
        const cardsOut = Array.isArray(result.cards)
          ? (result.cards as { front: string; back: string }[])
          : [];
        setGrade({
          attempt_id: String(result.attempt_id ?? ""),
          score: Number(result.score ?? 0),
          verdict:
            (result.verdict as "pass" | "borderline" | "fail" | undefined) ??
            "fail",
          missed_points: Array.isArray(result.missed_points)
            ? (result.missed_points as string[])
            : [],
          ideal_short_answer: String(result.ideal_short_answer ?? ""),
          cards: cardsOut,
          breakdown: {
            must_have_coverage: 0,
            answer_clarity: 0,
            tradeoff_coverage: 0,
            speed_score: 0,
            red_flag_penalty: 0,
          },
        });
      }
      return result;
    });
    return () => realtime.setToolHandler(null);
  }, [realtime.setToolHandler, session, startTimer]);

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

  const refreshSidecar = useCallback(async () => {
    try {
      const [prog, due] = await Promise.all([
        api.progress(),
        api.cardsDue(30),
      ]);
      setProgress(prog.skills.slice(0, 5));
      setDueCards(due.cards);
      setCardStats(due.stats);
    } catch (e) {
      // sidecar is non-fatal — surface but keep going
      console.warn("sidecar refresh failed:", (e as Error).message);
    }
  }, []);

  // Refresh sidecar (progress, due cards) on mount and after every grade.
  useEffect(() => {
    void refreshSidecar();
  }, [refreshSidecar, grade]);

  const onEndSession = useCallback(async () => {
    if (!session) return;
    setEnding(true);
    setError(null);
    try {
      const s = await api.endSession(session.id);
      stopTimer();
      setSummary(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEnding(false);
    }
  }, [session, stopTimer]);

  const onResetSession = useCallback(() => {
    stopTimer();
    setSummary(null);
    setSession(null);
    setDrill(null);
    setGrade(null);
    setTranscript("");
  }, [stopTimer]);

  const onOpenDrillBrowse = useCallback(async () => {
    setDrillBrowseOpen((v) => !v);
    if (!drillBrowse) {
      try {
        const r = await api.drills();
        setDrillBrowse(r.drills);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }, [drillBrowse]);

  const onReviewCard = useCallback(
    async (cardId: string, quality: 0 | 1) => {
      try {
        await api.reviewCard(cardId, quality);
        setDueCards((prev) => prev.filter((c) => c.id !== cardId));
        setRevealed((prev) => {
          const { [cardId]: _omit, ...rest } = prev;
          return rest;
        });
        void refreshSidecar();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshSidecar],
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>GPT Realtime Interview Drill Coach</h1>
        <div className="row" style={{ gap: "0.5rem" }}>
          <div className="status">
            {health
              ? `${health.drills} drills · OpenAI ${
                  health.openai_configured ? "ready" : "missing key"
                } · cards ${cardStats.due}/${cardStats.total} due`
              : "..."}
          </div>
          <a
            data-testid="export-cards"
            href="/api/cards/export.csv"
            download="drill-coach-cards.csv"
            style={{
              textDecoration: "none",
              color: "inherit",
              border: "1px solid var(--border)",
              padding: "0.35rem 0.6rem",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          >
            Export Anki CSV
          </a>
          <button
            data-testid="toggle-drill-browse"
            onClick={onOpenDrillBrowse}
            style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
          >
            {drillBrowseOpen ? "Hide" : "Browse"} drills
          </button>
        </div>
      </header>

      {progress.length > 0 && (
        <div
          className="panel"
          data-testid="progress-strip"
          style={{ gridColumn: "1 / -1", padding: "0.6rem 1rem" }}
        >
          <div className="row" style={{ alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", letterSpacing: "0.02em" }}>
              Weakest
            </strong>
            {progress.slice(0, 3).map((s) => (
              <span
                key={`${s.topic}:${s.subtopic}`}
                className="tag"
                title={`exposure ${s.exposure_count}`}
              >
                {s.topic} · {s.subtopic} ·{" "}
                {(s.weakness_score * 100).toFixed(0)}%
              </span>
            ))}
          </div>
        </div>
      )}

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
            <div data-testid="question" className="question">
              {drill.question_text.trim()}
            </div>
            {drill.prior_attempts && drill.prior_attempts.length > 0 && (
              <div
                className="row muted"
                data-testid="prior-attempts"
                style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}
              >
                <span>Prior attempts:</span>
                {drill.prior_attempts
                  .slice()
                  .reverse()
                  .map((p, i) => (
                    <span key={i} className="tag" title={p.verdict ?? ""}>
                      {Math.round(p.score * 100)}
                    </span>
                  ))}
              </div>
            )}

            <div
              className="row"
              style={{ marginTop: "0.9rem", marginBottom: "0.5rem" }}
            >
              <button
                data-testid="start-voice"
                onClick={() => {
                  if (realtime.status === "connected") {
                    void realtime.stop();
                    return;
                  }
                  if (drill) pushedVoiceDrillRef.current = drill.attempt_id;
                  void realtime.start(drill?.question_text);
                }}
                disabled={realtime.status === "connecting"}
              >
                {realtime.status === "connected"
                  ? "Stop voice"
                  : realtime.status === "connecting"
                    ? "Connecting..."
                    : "Start voice"}
              </button>
              <button
                data-testid="submit-answer"
                onClick={onSubmit}
                disabled={grading}
                className="primary"
              >
                {grading ? "Grading…" : "Submit answer"}
              </button>
              <button
                data-testid="next-drill"
                onClick={onNext}
                disabled={grading}
              >
                Next drill
              </button>
              <button
                data-testid="end-session"
                onClick={onEndSession}
                disabled={ending || grading}
                style={{ marginLeft: "auto" }}
              >
                {ending ? "Ending…" : "End session"}
              </button>
            </div>

            <textarea
              data-testid="transcript"
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
            <div className="scoreline" data-testid="grade-panel">
              <span className="score" data-testid="grade-score">
                {Math.round(grade.score * 100)}
              </span>
              <span className={verdictClass} data-testid="grade-verdict">
                {grade.verdict}
              </span>
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

      {summary && (
        <section
          className="panel"
          data-testid="session-summary"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.4rem" }}>
            <h2 style={{ margin: 0 }}>Session summary</h2>
            <span className="tag">mode {summary.mode}</span>
            <span className="tag">
              {summary.drills_graded}/{summary.drills_attempted} graded
            </span>
            <span className="tag">avg {Math.round(summary.average_score * 100)}</span>
            <span className="tag">
              {summary.passes} pass · {summary.borderlines} border · {summary.fails} fail
            </span>
            <button
              data-testid="reset-session"
              onClick={onResetSession}
              style={{ marginLeft: "auto" }}
            >
              Start a new session
            </button>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Topics covered: {summary.topics_covered.join(", ") || "—"}
          </p>
          {summary.attempts.length > 0 && (
            <div
              style={{
                display: "grid",
                gap: "0.3rem",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              }}
            >
              {summary.attempts.map((a) => (
                <div className="card" key={a.attempt_id}>
                  <div className="row" style={{ alignItems: "center" }}>
                    {a.topic && <span className="tag">{a.topic}</span>}
                    {a.subtopic && <span className="tag">{a.subtopic}</span>}
                    {a.score !== null && (
                      <span
                        className={`tag verdict-${a.verdict ?? ""}`}
                        style={{ marginLeft: "auto" }}
                      >
                        {Math.round(a.score * 100)} · {a.verdict}
                      </span>
                    )}
                  </div>
                  <div
                    className="muted"
                    style={{ fontSize: "0.78rem", marginTop: "0.2rem" }}
                  >
                    {a.duration_seconds ?? 0}s · {a.drill_id}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {drillBrowseOpen && drillBrowse && (
        <section
          className="panel"
          data-testid="drill-browse"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.5rem" }}>
            <h2 style={{ margin: 0 }}>
              Drill bank{" "}
              <span
                className="muted"
                style={{ fontWeight: 400, fontSize: "0.85rem" }}
              >
                ({drillBrowse.length} loaded)
              </span>
            </h2>
            <select
              value={drillBrowseFilter}
              onChange={(e) => setDrillBrowseFilter(e.target.value)}
              style={{ marginLeft: "auto" }}
            >
              <option value="">All topics</option>
              {[...new Set(drillBrowse.map((d) => d.topic))]
                .sort()
                .map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
            </select>
          </div>
          <div
            style={{
              display: "grid",
              gap: "0.4rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
            }}
          >
            {drillBrowse
              .filter(
                (d) =>
                  !drillBrowseFilter || d.topic === drillBrowseFilter,
              )
              .map((d) => (
                <div className="card" key={d.id}>
                  <div
                    className="row"
                    style={{ alignItems: "center", marginBottom: "0.25rem" }}
                  >
                    <span className="tag">{d.topic}</span>
                    <span className="tag">{d.subtopic}</span>
                    <span className="tag">d{d.difficulty}</span>
                    {d.trap_type && (
                      <span className="tag">{d.trap_type}</span>
                    )}
                    <button
                      style={{
                        marginLeft: "auto",
                        padding: "0.2rem 0.5rem",
                        fontSize: "0.75rem",
                      }}
                      onClick={() =>
                        setExpandedDrill((prev) =>
                          prev === d.id ? null : d.id,
                        )
                      }
                    >
                      {expandedDrill === d.id ? "Hide" : "Show"} rubric
                    </button>
                  </div>
                  <div style={{ fontSize: "0.85rem" }}>{d.question_text.trim()}</div>
                  {expandedDrill === d.id && (
                    <div
                      style={{
                        marginTop: "0.5rem",
                        fontSize: "0.78rem",
                        color: "var(--muted)",
                      }}
                    >
                      <strong>must:</strong>{" "}
                      {d.rubric.must_have.join(" · ")}
                      <br />
                      <strong>nice:</strong>{" "}
                      {d.rubric.nice_to_have.join(" · ") || "—"}
                      <br />
                      <strong>red flags:</strong>{" "}
                      {d.rubric.red_flags.join(" · ") || "—"}
                      <br />
                      <strong>ideal:</strong> {d.canonical_short_answer}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </section>
      )}

      <section
        className="panel"
        data-testid="card-review"
        style={{ gridColumn: "1 / -1" }}
      >
        <h2>
          Card review{" "}
          <span className="muted" style={{ fontWeight: 400, fontSize: "0.85rem" }}>
            ({cardStats.due} due / {cardStats.total} total)
          </span>
        </h2>
        {dueCards.length === 0 ? (
          <p className="muted">
            No cards due. Grade a drill and the missed points become flashcards
            scheduled with SM-2-lite (knew it stretches the interval, forgot
            resets it).
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gap: "0.6rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            }}
          >
            {dueCards.map((c) => (
              <div className="card" key={c.id} data-testid="card">
                <div className="front">{c.front}</div>
                {revealed[c.id] ? (
                  <div className="back" style={{ marginTop: "0.4rem" }}>
                    {c.back}
                  </div>
                ) : null}
                <div className="row" style={{ marginTop: "0.5rem", gap: "0.4rem" }}>
                  {!revealed[c.id] ? (
                    <button
                      data-testid="reveal-card"
                      onClick={() =>
                        setRevealed((prev) => ({ ...prev, [c.id]: true }))
                      }
                    >
                      Reveal
                    </button>
                  ) : (
                    <>
                      <button
                        data-testid="forgot-card"
                        onClick={() => onReviewCard(c.id, 0)}
                      >
                        Forgot
                      </button>
                      <button
                        data-testid="knew-card"
                        className="primary"
                        onClick={() => onReviewCard(c.id, 1)}
                      >
                        Knew it
                      </button>
                    </>
                  )}
                  {(c.topic || c.subtopic) && (
                    <span className="tag" style={{ marginLeft: "auto" }}>
                      {c.topic ?? ""}
                      {c.subtopic ? ` · ${c.subtopic}` : ""}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
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
