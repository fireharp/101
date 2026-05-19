import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  const [drillCount, setDrillCount] = useState(0);
  const [pressureMode, setPressureMode] = useState(false);
  const [resuming, setResuming] = useState(false);
  const MOCK_TARGET = 7;
  const SESSION_STORAGE_KEY = "drillCoachSession";
  const [drafts, setDrafts] = useState<
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
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [testTranscript, setTestTranscript] = useState<Record<string, string>>(
    {},
  );
  const [testResult, setTestResult] = useState<
    Record<string, { score: number; verdict: string; missed: number } | null>
  >({});
  const [editingDrill, setEditingDrill] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    must_have: string;
    nice_to_have: string;
    red_flags: string;
    canonical_short_answer: string;
    difficulty: number;
  }>({
    must_have: "",
    nice_to_have: "",
    red_flags: "",
    canonical_short_answer: "",
    difficulty: 3,
  });
  const [savingEdit, setSavingEdit] = useState(false);

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
      realtime.pushDrill(drill.question_text, { pressure: pressureMode });
      pushedVoiceDrillRef.current = drill.attempt_id;
    }
  }, [drill, pressureMode, realtime.pushDrill, realtime.status]);

  // Keep the resume bookmark fresh when mode or pressure toggle mid-session.
  useEffect(() => {
    if (!session) return;
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        session_id: session.id,
        mode,
        pressure_mode: pressureMode,
      }),
    );
  }, [mode, pressureMode, session]);

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

  // Persist session bookmark in localStorage so a refresh resumes where
  // the user left off. The backend already has all the durable state
  // (attempts, weakness, cards); we just need the session id + mode.
  useEffect(() => {
    let cancelled = false;
    const raw =
      typeof window !== "undefined"
        ? window.localStorage.getItem(SESSION_STORAGE_KEY)
        : null;
    if (!raw) return;
    let parsed: { session_id?: string; mode?: Mode; pressure_mode?: boolean };
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    if (!parsed.session_id) return;
    setResuming(true);
    void (async () => {
      try {
        const sum = await api.sessionSummary(parsed.session_id!);
        if (cancelled) return;
        if (sum.ended_at) {
          window.localStorage.removeItem(SESSION_STORAGE_KEY);
          return;
        }
        setSession({
          id: sum.session_id,
          user_id: "demo-user",
          mode: sum.mode,
        });
        setMode(sum.mode);
        if (parsed.pressure_mode) setPressureMode(true);
        const openAttempt = sum.attempts
          .slice()
          .reverse()
          .find((a) => a.score === null);
        if (openAttempt) {
          const bank = await api.drills();
          if (cancelled) return;
          const item = bank.drills.find((d) => d.id === openAttempt.drill_id);
          if (item) {
            setDrill({
              drill_id: item.id,
              attempt_id: openAttempt.attempt_id,
              question_text: item.question_text,
              topic: item.topic,
              subtopic: item.subtopic,
              difficulty: item.difficulty,
              expected_answer_shape: item.rubric.must_have,
              rubric: item.rubric,
            });
            setDrillCount(sum.drills_attempted);
            return;
          }
        }
        // No open attempt to resume, so create the next pending attempt.
        const d = await api.nextDrill(sum.session_id, sum.mode);
        if (cancelled) return;
        setDrill(d);
        setDrillCount(sum.drills_attempted + 1);
        startedAtRef.current = Date.now();
        setElapsed(0);
      } catch {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setDrillCount(0);
    try {
      const s = await api.startSession(mode);
      setSession(s);
      window.localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          session_id: s.id,
          mode,
          pressure_mode: pressureMode,
        }),
      );
      const d = await api.nextDrill(s.id, mode);
      setDrill(d);
      setDrillCount(1);
      startTimer();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mode, pressureMode, startTimer]);

  const onNext = useCallback(async () => {
    if (!session) return;
    setError(null);
    setGrade(null);
    setTranscript("");
    try {
      const d = await api.nextDrill(session.id, mode);
      setDrill(d);
      setDrillCount((c) => c + 1);
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
      setProgress(prog.skills);
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
    setDrillCount(0);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }, [stopTimer]);

  const refreshDrafts = useCallback(async () => {
    try {
      const r = await api.drafts();
      setDrafts(r.drills);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onToggleDrafts = useCallback(async () => {
    setDraftsOpen((v) => !v);
    if (!drafts) {
      void refreshDrafts();
    }
  }, [drafts, refreshDrafts]);

  const onActivateDraft = useCallback(
    async (id: string) => {
      try {
        await api.activateDrill(id);
        // Refresh both drafts and the active browse list.
        await refreshDrafts();
        if (drillBrowse) {
          const r = await api.drills();
          setDrillBrowse(r.drills);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [drillBrowse, refreshDrafts],
  );

  const onDiscardDraft = useCallback(
    async (id: string) => {
      try {
        await api.deleteDrill(id);
        await refreshDrafts();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshDrafts],
  );

  const onStartEdit = useCallback(
    (d: {
      id: string;
      canonical_short_answer: string;
      difficulty: number;
      rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
    }) => {
      setEditingDrill(d.id);
      setEditForm({
        must_have: d.rubric.must_have.join("\n"),
        nice_to_have: d.rubric.nice_to_have.join("\n"),
        red_flags: d.rubric.red_flags.join("\n"),
        canonical_short_answer: d.canonical_short_answer,
        difficulty: d.difficulty,
      });
    },
    [],
  );

  const onCancelEdit = useCallback(() => {
    setEditingDrill(null);
  }, []);

  const onSaveEdit = useCallback(
    async (id: string) => {
      setSavingEdit(true);
      setError(null);
      const splitLines = (s: string) =>
        s
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
      try {
        await api.patchDrill(id, {
          canonical_short_answer: editForm.canonical_short_answer,
          difficulty: editForm.difficulty,
          rubric: {
            must_have: splitLines(editForm.must_have),
            nice_to_have: splitLines(editForm.nice_to_have),
            red_flags: splitLines(editForm.red_flags),
          },
        });
        // Refresh browse list to reflect saved values.
        const r = await api.drills();
        setDrillBrowse(r.drills);
        setEditingDrill(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSavingEdit(false);
      }
    },
    [editForm],
  );

  const onTestGrade = useCallback(
    async (id: string) => {
      const text = (testTranscript[id] ?? "").trim();
      if (!text) return;
      try {
        const r = await api.testGrade(id, text);
        setTestResult((prev) => ({
          ...prev,
          [id]: {
            score: r.score,
            verdict: r.verdict,
            missed: r.missed_points.length,
          },
        }));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [testTranscript],
  );

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
            data-testid="pressure-mode-toggle"
            onClick={() => setPressureMode((v) => !v)}
            title="When on, the voice agent interrupts rambling and forces pressure follow-ups."
            style={{
              padding: "0.35rem 0.6rem",
              fontSize: "0.85rem",
              background: pressureMode ? "var(--bad)" : "var(--panel)",
              color: pressureMode ? "#0c1220" : "inherit",
              borderColor: pressureMode ? "var(--bad)" : "var(--border)",
            }}
          >
            Pressure {pressureMode ? "ON" : "off"}
          </button>
          <button
            data-testid="toggle-drill-browse"
            onClick={onOpenDrillBrowse}
            style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
          >
            {drillBrowseOpen ? "Hide" : "Browse"} drills
          </button>
          <button
            data-testid="toggle-drafts"
            onClick={onToggleDrafts}
            style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
            title="Layer-3 generator drafts (is_active=false)"
          >
            {draftsOpen ? "Hide" : "Show"} drafts
            {drafts && drafts.length > 0 ? ` (${drafts.length})` : ""}
          </button>
        </div>
      </header>

      {progress.length > 0 && (
        <div
          className="panel"
          data-testid="progress-strip"
          style={{ gridColumn: "1 / -1", padding: "0.6rem 1rem" }}
        >
          <div className="row" style={{ alignItems: "center", marginBottom: "0.4rem" }}>
            <strong style={{ fontSize: "0.85rem", letterSpacing: "0.02em" }}>
              Skill weakness by subtopic
            </strong>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              ({progress.length} touched)
            </span>
            <span className="muted" style={{ marginLeft: "auto", fontSize: "0.72rem" }}>
              0% = mastered · 100% = always fails
            </span>
          </div>
          <div data-testid="skill-graph" style={{ display: "grid", gap: "0.25rem" }}>
            {progress
              .slice()
              .sort((a, b) => b.weakness_score - a.weakness_score)
              .map((s) => {
                const pct = Math.round(s.weakness_score * 100);
                const color =
                  s.weakness_score >= 0.7
                    ? "var(--bad)"
                    : s.weakness_score >= 0.4
                      ? "var(--warn)"
                      : "var(--good)";
                return (
                  <div
                    key={`${s.topic}:${s.subtopic}`}
                    className="row"
                    style={{ alignItems: "center", gap: "0.5rem" }}
                  >
                    <span
                      style={{
                        flex: "0 0 180px",
                        fontSize: "0.78rem",
                        color: "var(--muted)",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                      }}
                      title={`${s.topic} · ${s.subtopic} · exposure ${s.exposure_count}`}
                    >
                      {s.topic} · {s.subtopic}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        background: "#0a0c12",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        height: 14,
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background: color,
                          transition: "width 200ms ease",
                        }}
                      />
                    </div>
                    <span
                      style={{
                        flex: "0 0 48px",
                        textAlign: "right",
                        fontSize: "0.75rem",
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--muted)",
                      }}
                    >
                      {pct}%
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <section className="panel">
        <h2>Drill</h2>

        {resuming && !drill && (
          <p className="muted" data-testid="resume-status">
            Resuming previous session...
          </p>
        )}

        {!drill && !resuming && (
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
              {session?.mode === "mock_interview" && (
                <span
                  className="tag"
                  data-testid="mock-progress"
                  style={{
                    background:
                      drillCount > MOCK_TARGET
                        ? "var(--warn)"
                        : "transparent",
                    color:
                      drillCount > MOCK_TARGET ? "#0c1220" : "inherit",
                  }}
                >
                  Drill {drillCount} of {MOCK_TARGET}
                  {drillCount >= MOCK_TARGET ? " — end soon" : ""}
                </span>
              )}
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
                  void realtime.start(drill?.question_text, {
                    pressure: pressureMode,
                  });
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

      {draftsOpen && drafts && (
        <section
          className="panel"
          data-testid="drafts"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.4rem" }}>
            <h2 style={{ margin: 0 }}>
              Layer-3 drafts{" "}
              <span
                className="muted"
                style={{ fontWeight: 400, fontSize: "0.85rem" }}
              >
                ({drafts.length})
              </span>
            </h2>
            <span className="muted" style={{ marginLeft: "auto", fontSize: "0.8rem" }}>
              LLM-generated drills, inactive until you activate.
            </span>
          </div>
          {drafts.length === 0 ? (
            <p className="muted">
              No drafts. Run{" "}
              <code>pnpm --filter @drill/backend gen:drills -- --topic X --count N</code>{" "}
              to produce some.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "0.5rem",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              }}
            >
              {drafts.map((d) => (
                <div className="card" key={d.id} data-testid="draft-card">
                  <div
                    className="row"
                    style={{ alignItems: "center", marginBottom: "0.25rem" }}
                  >
                    <span className="tag">{d.topic}</span>
                    <span className="tag">{d.subtopic}</span>
                    <span className="tag">d{d.difficulty}</span>
                  </div>
                  <div style={{ fontSize: "0.85rem", marginBottom: "0.4rem" }}>
                    {d.question_text.trim()}
                  </div>
                  <div
                    className="muted"
                    style={{ fontSize: "0.75rem", marginBottom: "0.4rem" }}
                  >
                    <strong>must:</strong>{" "}
                    {d.rubric.must_have.join(" · ")}
                    {d.rubric.red_flags.length > 0 && (
                      <>
                        <br />
                        <strong>red flags:</strong>{" "}
                        {d.rubric.red_flags.join(" · ")}
                      </>
                    )}
                  </div>
                  <div className="row" style={{ gap: "0.4rem" }}>
                    <button
                      data-testid="activate-draft"
                      className="primary"
                      onClick={() => onActivateDraft(d.id)}
                    >
                      Activate
                    </button>
                    <button
                      data-testid="discard-draft"
                      onClick={() => onDiscardDraft(d.id)}
                    >
                      Discard
                    </button>
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
                      {editingDrill === d.id ? (
                        <div
                          data-testid="rubric-editor"
                          style={{
                            display: "grid",
                            gap: "0.4rem",
                            color: "var(--text)",
                          }}
                        >
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Must-have (one per line)
                            </span>
                            <textarea
                              rows={4}
                              value={editForm.must_have}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  must_have: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Nice-to-have
                            </span>
                            <textarea
                              rows={3}
                              value={editForm.nice_to_have}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  nice_to_have: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Red flags
                            </span>
                            <textarea
                              rows={3}
                              value={editForm.red_flags}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  red_flags: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Ideal short answer
                            </span>
                            <textarea
                              rows={3}
                              value={editForm.canonical_short_answer}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  canonical_short_answer: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                            <span style={{ fontSize: "0.75rem" }}>Difficulty</span>
                            <select
                              value={editForm.difficulty}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  difficulty: Number(e.target.value),
                                }))
                              }
                            >
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="row" style={{ gap: "0.4rem" }}>
                            <button
                              data-testid="save-rubric"
                              className="primary"
                              disabled={savingEdit}
                              onClick={() => onSaveEdit(d.id)}
                              style={{ fontSize: "0.78rem", padding: "0.25rem 0.5rem" }}
                            >
                              {savingEdit ? "Saving…" : "Save rubric"}
                            </button>
                            <button
                              onClick={onCancelEdit}
                              style={{ fontSize: "0.78rem", padding: "0.25rem 0.5rem" }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
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
                          <div style={{ marginTop: "0.3rem" }}>
                            <button
                              data-testid="edit-rubric"
                              onClick={() => onStartEdit(d)}
                              style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                            >
                              Edit rubric
                            </button>
                          </div>
                        </>
                      )}
                      <div
                        style={{
                          marginTop: "0.5rem",
                          borderTop: "1px solid var(--border)",
                          paddingTop: "0.4rem",
                          color: "var(--text)",
                        }}
                      >
                        <strong style={{ fontSize: "0.8rem" }}>
                          Test grade (no persist)
                        </strong>
                        <textarea
                          data-testid="test-grade-input"
                          placeholder="Paste a sample answer to dry-run the grader against this rubric."
                          value={testTranscript[d.id] ?? ""}
                          onChange={(e) =>
                            setTestTranscript((prev) => ({
                              ...prev,
                              [d.id]: e.target.value,
                            }))
                          }
                          rows={3}
                          style={{
                            width: "100%",
                            marginTop: "0.3rem",
                            fontFamily: "inherit",
                            fontSize: "0.8rem",
                            color: "inherit",
                            background: "#0a0c12",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "0.4rem 0.5rem",
                          }}
                        />
                        <div
                          className="row"
                          style={{ marginTop: "0.3rem", gap: "0.4rem" }}
                        >
                          <button
                            data-testid="test-grade-run"
                            onClick={() => onTestGrade(d.id)}
                            style={{ fontSize: "0.78rem", padding: "0.25rem 0.5rem" }}
                          >
                            Run grader
                          </button>
                          {testResult[d.id] && (
                            <span
                              className={`tag verdict-${testResult[d.id]!.verdict}`}
                            >
                              {Math.round(testResult[d.id]!.score * 100)} ·{" "}
                              {testResult[d.id]!.verdict} · {testResult[d.id]!.missed}{" "}
                              missed
                            </span>
                          )}
                        </div>
                      </div>
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

const editorTextareaStyle: CSSProperties = {
  width: "100%",
  fontFamily: "inherit",
  fontSize: "0.78rem",
  color: "inherit",
  background: "#0a0c12",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0.35rem 0.5rem",
  resize: "vertical",
};

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
