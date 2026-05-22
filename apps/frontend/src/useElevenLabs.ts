import { Conversation, type VoiceConversation } from "@elevenlabs/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type RealtimeSettings } from "./api.ts";
import type {
  RealtimeDebugEvent,
  RealtimeHandle,
  RealtimeMessage,
  RealtimeToolCall,
  RealtimeToolHandler,
  RealtimeUsageHandler,
} from "./useRealtime.ts";

type Status = RealtimeHandle["status"];

type ElevenLabsDebug = {
  status: string;
  events: RealtimeDebugEvent[];
  errors: string[];
};

declare global {
  interface Window {
    __drillElevenLabsDebug?: ElevenLabsDebug;
    __drillElevenLabsSend?: (event: Record<string, unknown>) => void;
  }
}

const TOOL_NAMES = [
  "get_next_drill",
  "submit_answer_transcript",
  "grade_attempt",
  "save_generated_cards",
  "get_user_skill_summary",
  "end_session_summary",
] as const;

export function useElevenLabs(): RealtimeHandle {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [agentTranscript, setAgentTranscript] = useState("");
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [debugEvents, setDebugEvents] = useState<RealtimeDebugEvent[]>([]);

  const conversationRef = useRef<VoiceConversation | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const volumeTimerRef = useRef<number | null>(null);
  const toolHandlerRef = useRef<RealtimeToolHandler | null>(null);
  const usageHandlerRef = useRef<RealtimeUsageHandler | null>(null);
  const statusRef = useRef<Status>("idle");
  const errorRef = useRef<string | null>(null);

  const pushDebug = useCallback((event: RealtimeDebugEvent) => {
    setDebugEvents((prev) => {
      const next = [...prev.slice(-99), event];
      window.__drillElevenLabsDebug = {
        status: statusRef.current,
        events: next,
        errors: errorRef.current ? [errorRef.current] : [],
      };
      return next;
    });
  }, []);

  useEffect(() => {
    statusRef.current = status;
    window.__drillElevenLabsDebug = {
      status,
      events: debugEvents,
      errors: error ? [error] : [],
    };
  }, [debugEvents, error, status]);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const setToolHandler = useCallback((handler: RealtimeToolHandler | null) => {
    toolHandlerRef.current = handler;
  }, []);

  const setUsageHandler = useCallback((handler: RealtimeUsageHandler | null) => {
    usageHandlerRef.current = handler;
  }, []);

  const startVolumePoll = useCallback(() => {
    if (volumeTimerRef.current !== null) {
      window.clearInterval(volumeTimerRef.current);
    }
    volumeTimerRef.current = window.setInterval(() => {
      try {
        setMicLevel(conversationRef.current?.getInputVolume() ?? 0);
      } catch {
        setMicLevel(0);
      }
    }, 100) as unknown as number;
  }, []);

  const stopVolumePoll = useCallback(() => {
    if (volumeTimerRef.current !== null) {
      window.clearInterval(volumeTimerRef.current);
      volumeTimerRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const appendMessage = useCallback((message: RealtimeMessage) => {
    setMessages((prev) => [...prev.slice(-80), message]);
  }, []);

  const runToolCall = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      const call: RealtimeToolCall = {
        name,
        call_id: `elevenlabs-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        arguments: args,
      };
      pushDebug({
        type: "client_tool_call",
        at: Date.now(),
        state: name,
      });
      const handler = toolHandlerRef.current;
      if (!handler) {
        return JSON.stringify({ error: "tool handler is not registered" });
      }
      try {
        const result = await handler(call);
        pushDebug({
          type: "tool_call.handled",
          at: Date.now(),
          state: name,
        });
        return JSON.stringify(result);
      } catch (err) {
        const message = (err as Error).message;
        pushDebug({
          type: "tool_call.error",
          at: Date.now(),
          state: name,
          message,
        });
        return JSON.stringify({ error: message });
      }
    },
    [pushDebug],
  );

  const buildClientTools = useCallback(() => {
    return Object.fromEntries(
      TOOL_NAMES.map((name) => [
        name,
        (parameters: unknown) =>
          runToolCall(
            name,
            isRecord(parameters) ? parameters : { value: parameters },
          ),
      ]),
    );
  }, [runToolCall]);

  const sendDrillInstruction = useCallback(
    (
      question: string,
      opts?: { pressure?: boolean; attemptId?: string; autoAdvance?: boolean },
    ) => {
      const conversation = conversationRef.current;
      if (!conversation?.isOpen()) return;
      const pressure = opts?.pressure
        ? " Pressure mode is on: interrupt rambling and ask one pressure follow-up when needed."
        : "";
      const autoAdvance =
        (opts?.autoAdvance ?? true)
          ? " After grading, immediately call get_next_drill and ask the next question."
          : " After grading, stop; the host app picks the next drill.";
      const attemptId = opts?.attemptId ?? "unknown";
      // sendContextualUpdate (not sendUserMessage) — this is host-level
      // context, not a fake user turn. Without this, the agent's ASR
      // pipeline can race the user's first real audio. Also mirror the
      // OpenAI useRealtime discipline: "Do not call get_next_drill before
      // asking this question" so the host-selected drill is honored
      // instead of the agent autonomously fetching a different one.
      conversation.sendContextualUpdate(
        `Host app selected this drill. attempt_id=${attemptId}. ` +
          `Do not call get_next_drill before asking this question. ` +
          `Ask exactly this question aloud, then wait for my spoken answer: ${question}. ` +
          `After I answer, your next action must be submit_answer_transcript with attempt_id=${attemptId} before any commentary, then grade_attempt with the same attempt_id.${pressure}${autoAdvance}`,
      );
      pushDebug({
        type: "host.drill_pushed",
        at: Date.now(),
        state: attemptId,
        transcriptLength: question.length,
      });
    },
    [pushDebug],
  );

  const stop = useCallback(async () => {
    setStatus("stopping");
    stopVolumePoll();
    try {
      await conversationRef.current?.endSession();
    } finally {
      conversationRef.current = null;
      setIsAgentSpeaking(false);
      setStatus("idle");
      pushDebug({ type: "session.stopped", at: Date.now() });
    }
  }, [pushDebug, stopVolumePoll]);

  const start = useCallback<RealtimeHandle["start"]>(
    async (initialDrill, opts) => {
      if (conversationRef.current?.isOpen()) {
        if (initialDrill) sendDrillInstruction(initialDrill, opts);
        return;
      }
      setStatus("connecting");
      setError(null);
      setTranscript("");
      setAgentTranscript("");
      setMessages([]);
      setDebugEvents([]);

      try {
        const token = await api.elevenLabsConversationToken();
        pushDebug({
          type: "conversation_token.ok",
          at: Date.now(),
          state: token.agent_id,
        });
        const conversation = await Conversation.startSession({
          conversationToken: token.token,
          connectionType: "webrtc",
          clientTools: buildClientTools(),
          overrides: buildOverrides(opts?.settings),
          onConnect: ({ conversationId }) => {
            setStatus("connected");
            pushDebug({
              type: "session.connected",
              at: Date.now(),
              state: conversationId,
            });
          },
          onDisconnect: (details) => {
            setStatus("idle");
            setIsAgentSpeaking(false);
            stopVolumePoll();
            pushDebug({
              type: "session.disconnected",
              at: Date.now(),
              message: details.reason,
            });
          },
          onError: (message) => {
            setError(message);
            setStatus("error");
            pushDebug({ type: "session.error", at: Date.now(), message });
          },
          onStatusChange: ({ status: sdkStatus }) => {
            const mapped = mapStatus(sdkStatus);
            setStatus(mapped);
            pushDebug({ type: "status", at: Date.now(), state: sdkStatus });
          },
          onModeChange: ({ mode }) => {
            setIsAgentSpeaking(mode === "speaking");
            pushDebug({ type: "mode", at: Date.now(), state: mode });
          },
          onMessage: ({ role, message, event_id }) => {
            if (!message.trim() || isHostInstruction(message)) return;
            const msg: RealtimeMessage = {
              id: `elevenlabs-${event_id ?? Date.now()}-${role}`,
              role: role === "agent" ? "coach" : "user",
              text: message,
              at: Date.now(),
            };
            appendMessage(msg);
            // Log a debug event so smoke scripts can measure first-message
            // timings per §8. Length-only — never the message text (privacy).
            pushDebug({
              type: "message",
              at: Date.now(),
              state: role,
              transcriptLength: message.length,
            });
            if (role === "user") {
              setTranscript(message);
            } else {
              setAgentTranscript((prev) => (prev ? `${prev}\n${message}` : message));
            }
          },
          onVadScore: ({ vadScore }) => {
            setMicLevel(Math.max(0, Math.min(1, vadScore)));
          },
          onDebug: (info) => {
            pushDebug({
              type: "debug",
              at: Date.now(),
              message: stringifyDebug(info),
            });
          },
        });
        conversationRef.current =
          conversation.type === "voice" ? conversation : null;
        if (!conversationRef.current) {
          throw new Error("ElevenLabs did not return a voice conversation");
        }
        startVolumePoll();
        setStatus("connected");
        if (initialDrill) {
          window.setTimeout(() => sendDrillInstruction(initialDrill, opts), 250);
        }
      } catch (err) {
        const message = (err as Error).message;
        setError(message);
        setStatus("error");
        stopVolumePoll();
        pushDebug({ type: "session.start_error", at: Date.now(), message });
        throw err;
      }
    },
    [
      appendMessage,
      buildClientTools,
      pushDebug,
      sendDrillInstruction,
      startVolumePoll,
      stopVolumePoll,
    ],
  );

  const send = useCallback((event: Record<string, unknown>) => {
    // response.create has no ElevenLabs analogue — silently ignore it so
    // smoke scripts written for the OpenAI path can re-use the same
    // "stop session" pattern against the ElevenLabs path.
    if (event.type === "response.create") return;
    const text = extractText(event);
    if (text) conversationRef.current?.sendUserMessage(text);
  }, []);

  // Smoke-test hook: parallel to useRealtime's __drillRealtimeSend, so
  // Playwright can inject faux-user messages while the ElevenLabs path
  // is active (e.g. "Stop. End session." to exercise end_session_summary).
  useEffect(() => {
    window.__drillElevenLabsSend = send;
    return () => {
      delete window.__drillElevenLabsSend;
    };
  }, [send]);

  const pushDrill = useCallback<RealtimeHandle["pushDrill"]>(
    (question, opts) => sendDrillInstruction(question, opts),
    [sendDrillInstruction],
  );

  const updateSessionSettings = useCallback((settings: RealtimeSettings) => {
    try {
      conversationRef.current?.setVolume({ volume: 1 });
      pushDebug({
        type: "settings.ignored",
        at: Date.now(),
        message: `ElevenLabs session settings are applied on next start; requested ${settings.voice_speed.toFixed(2)}x`,
      });
    } catch {
      /* noop */
    }
  }, [pushDebug]);

  useEffect(() => {
    return () => {
      stopVolumePoll();
      void conversationRef.current?.endSession();
      conversationRef.current = null;
    };
  }, [stopVolumePoll]);

  return {
    status,
    error,
    start,
    stop,
    transcript,
    agentTranscript,
    messages,
    isAgentSpeaking,
    micLevel,
    debugEvents,
    audioEl: audioElRef,
    send,
    pushDrill,
    updateSessionSettings,
    setToolHandler,
    setUsageHandler,
  };
}

function buildOverrides(_settings?: RealtimeSettings): undefined {
  // Don't send `overrides` to ElevenLabs unless the agent's config explicitly
  // allows the field. Sending `tts.speed` without enabling speed-overrides
  // on the agent fails the conversation immediately with
  //   code: 1008, reason: "Override for field 'speed' is not allowed by config."
  // (verified against the live agent on 2026-05-20).
  //
  // The UI's voice_speed slider is OpenAI-only; ElevenLabs speed is fixed
  // server-side via the agent's TTS config and tuned via pnpm elevenlabs:setup.
  return undefined;
}

function mapStatus(status: string): Status {
  if (status === "connecting") return "connecting";
  if (status === "connected") return "connected";
  if (status === "disconnecting") return "stopping";
  return "idle";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(event: Record<string, unknown>): string | null {
  // Match the OpenAI Realtime event shape that smoke scripts inject:
  //   { type:"conversation.item.create",
  //     item:{ type:"message", role:"user",
  //            content:[{ type:"input_text", text:"..." }] } }
  const item = event.item;
  if (isRecord(item)) {
    if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (
          isRecord(block) &&
          typeof block.text === "string" &&
          block.text.trim()
        ) {
          return block.text;
        }
      }
    }
    if (typeof item.text === "string") return item.text;
  }
  if (typeof event.text === "string") return event.text;
  if (typeof event.message === "string") return event.message;
  return null;
}

function isHostInstruction(message: string): boolean {
  return message.startsWith("Host app selected this drill.");
}

function stringifyDebug(info: unknown): string {
  if (typeof info === "string") return info;
  try {
    return JSON.stringify(info).slice(0, 500);
  } catch {
    return String(info).slice(0, 500);
  }
}
