import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  isApiError,
  type RealtimeSettings,
  type RealtimeUsageEvent,
} from "./api.ts";

/**
 * WebRTC client for OpenAI Realtime per LOCAL.md §3 Option A.
 *
 * Flow:
 *   1. Backend mints an ephemeral client_secret (POST /api/realtime/token).
 *   2. We create an RTCPeerConnection, add mic audio, attach a data channel.
 *   3. We POST our SDP offer to /v1/realtime/calls with the ephemeral token.
 *   4. We apply the SDP answer. Audio + events stream over WebRTC.
 *
 * The data channel is currently used to receive transcript deltas from
 * the model and the user. We expose them via `transcript` so the UI can
 * stream them and submit on stop.
 */

type Status =
  | "idle"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

type RealtimeServerEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  error?: { message?: string };
  response_id?: string;
  usage?: Record<string, unknown>;
  response?: { id?: string; model?: string; usage?: Record<string, unknown> };
  // Function-call events (LOCAL.md §6 tool protocol).
  // `name` is reliably present on `response.output_item.{added,done}` when
  // item.type=function_call. `response.function_call_arguments.done` may
  // omit it depending on API version, so we track the (item_id → name)
  // mapping ourselves.
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
};

export type RealtimeToolCall = {
  name: string;
  call_id: string;
  arguments: Record<string, unknown>;
};

export type RealtimeMessage = {
  id: string;
  role: "coach" | "user";
  text: string;
  at: number;
};

export type RealtimeToolHandler = (
  call: RealtimeToolCall,
) => Promise<Record<string, unknown>>;

export type RealtimeUsageHandler = (
  event: RealtimeUsageEvent,
) => Promise<void> | void;

export type RealtimeDebugEvent = {
  type: string;
  at: number;
  state?: string;
  message?: string;
  deltaLength?: number;
  transcriptLength?: number;
  statusCode?: number;
  requestId?: string | null;
  openaiRequestId?: string | null;
  retryable?: boolean;
};

type RealtimeDebug = {
  status: string;
  events: RealtimeDebugEvent[];
  toolCalls?: RealtimeDebugEvent[];
  errors: string[];
  rawFunctionCallEvents?: unknown[];
};

declare global {
  interface Window {
    __drillRealtimeDebug?: RealtimeDebug;
    // Exposed for smoke tests so they can inject faux-user messages over
    // the data channel (e.g. to assert the "stop" / end_session_summary
    // path). Available only while the data channel is open.
    __drillRealtimeSend?: (event: Record<string, unknown>) => void;
    // Smoke flag: when set, the autonomy backstop in runToolCall stops
    // injecting "Next drill, please" after each grade. Used by the
    // end_session_summary smoke so the "Stop" message wins.
    __drillSuppressAutoNextDrill?: boolean;
  }
}

export interface RealtimeHandle {
  status: Status;
  error: string | null;
  start: (
    initialDrill?: string,
    opts?: {
      pressure?: boolean;
      attemptId?: string;
      settings?: RealtimeSettings;
      autoAdvance?: boolean;
    },
  ) => Promise<void>;
  stop: () => Promise<void>;
  transcript: string;
  agentTranscript: string;
  messages: RealtimeMessage[];
  /**
   * True while the model is emitting audio for the current response.
   * Derived from response.output_audio_transcript.delta arrival vs the
   * matching response.done. Useful for "🔊 Coach speaking" badges.
   */
  isAgentSpeaking: boolean;
  /**
   * 0..1 RMS of the local mic stream, sampled ~10 Hz. Lets the UI prove
   * the mic is alive without listening to a Web Audio loopback.
   */
  micLevel: number;
  debugEvents: RealtimeDebugEvent[];
  audioEl: React.RefObject<HTMLAudioElement | null>;
  send: (event: Record<string, unknown>) => void;
  pushDrill: (
    question: string,
    opts?: { pressure?: boolean; attemptId?: string; autoAdvance?: boolean },
  ) => void;
  updateSessionSettings: (settings: RealtimeSettings) => void;
  setToolHandler: (handler: RealtimeToolHandler | null) => void;
  setUsageHandler: (handler: RealtimeUsageHandler | null) => void;
}

export function useRealtime(): RealtimeHandle {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [agentTranscript, setAgentTranscript] = useState("");
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [debugEvents, setDebugEvents] = useState<RealtimeDebugEvent[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micLevelRafRef = useRef<number | null>(null);
  const unmountStopTimerRef = useRef<number | null>(null);
  const transcriptItemsRef = useRef<Map<string, string>>(new Map());
  const agentTranscriptItemsRef = useRef<Map<string, string>>(new Map());
  const messagesRef = useRef<Map<string, RealtimeMessage>>(new Map());
  const toolHandlerRef = useRef<RealtimeToolHandler | null>(null);
  const usageHandlerRef = useRef<RealtimeUsageHandler | null>(null);
  const modelRef = useRef<string | null>(null);
  const autoAdvanceRef = useRef(true);
  const pendingAutoNextRef = useRef(false);
  const autoNextResponseIdRef = useRef<string | null>(null);
  const autoNextTimerRef = useRef<number | null>(null);
  const pendingFunctionCallsRef = useRef<
    Map<string, { name: string; call_id: string; dispatched: boolean }>
  >(new Map());

  const setToolHandler = useCallback((handler: RealtimeToolHandler | null) => {
    toolHandlerRef.current = handler;
  }, []);

  const setUsageHandler = useCallback((handler: RealtimeUsageHandler | null) => {
    usageHandlerRef.current = handler;
  }, []);

  const send = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(event));
  }, []);

  // Expose `send` so smoke tests can inject faux user messages. This is a
  // test hook (Playwright reads `window.__drillRealtimeSend`); it's safe
  // to leave on in production because it requires an active data channel
  // and the agent will reject malformed payloads.
  useEffect(() => {
    window.__drillRealtimeSend = send;
    return () => {
      delete window.__drillRealtimeSend;
    };
  }, [send]);

  const closeRealtime = useCallback(async () => {
    try {
      dcRef.current?.close();
    } catch {
      /* noop */
    }
    try {
      pcRef.current?.getSenders().forEach((s) => s.track?.stop());
      pcRef.current?.close();
    } catch {
      /* noop */
    }
    try {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    try {
      if (micLevelRafRef.current !== null) {
        window.clearTimeout(micLevelRafRef.current);
        micLevelRafRef.current = null;
      }
      if (autoNextTimerRef.current !== null) {
        window.clearTimeout(autoNextTimerRef.current);
        autoNextTimerRef.current = null;
      }
      await audioCtxRef.current?.close();
    } catch {
      /* noop */
    }
    dcRef.current = null;
    pcRef.current = null;
    micStreamRef.current = null;
    audioCtxRef.current = null;
    pendingAutoNextRef.current = false;
    autoNextResponseIdRef.current = null;
    setMicLevel(0);
    setIsAgentSpeaking(false);
  }, []);

  const stop = useCallback(async () => {
    setStatus("stopping");
    recordDebugStatus("stopping");
    await closeRealtime();
    setStatus("idle");
    recordDebugStatus("idle");
  }, [closeRealtime]);

  const syncDebugEvents = useCallback(() => {
    setDebugEvents([...getDebug().events].slice(-12));
  }, []);

  const updateSessionSettings = useCallback(
    (settings: RealtimeSettings) => {
      send({
        type: "session.update",
        session: buildRealtimeSessionUpdate(settings),
      });
      recordDebugEvent("session.update.settings", {
        state: `${settings.vad.mode}/${settings.voice_speed}x`,
      });
      syncDebugEvents();
    },
    [send, syncDebugEvents],
  );

  const pushDrill = useCallback(
    (
      question: string,
      opts: { pressure?: boolean; attemptId?: string; autoAdvance?: boolean } = {},
    ) => {
      if (!question) return;
      const autoAdvance = opts.autoAdvance ?? true;
      autoAdvanceRef.current = autoAdvance;
      const pressureClause = opts.pressure
        ? "\n\nPRESSURE MODE: interrupt rambling after ~10 seconds. If the user stalls, snap 'Default answer now.' Be sharper, shorter, more critical than usual. Force at least one pressure follow-up regardless of answer quality."
        : "";
      const attemptClause = opts.attemptId
        ? `\n\nThe host app already selected this drill. attempt_id=${opts.attemptId}. Do not call get_next_drill before asking this question. After I answer, your next action must be submit_answer_transcript with this attempt_id before any commentary, then grade_attempt.`
        : "";
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Ask me this drill aloud, exactly once, then wait for my spoken answer:\n" +
                question.trim() +
                attemptClause +
                pressureClause,
            },
          ],
        },
      });
      send({
        type: "response.create",
        response: {
          tools: [],
          instructions:
            "Ask the current drill question above in one breath, then stop and wait for the user's answer. Do not give hints. After the user answers, call submit_answer_transcript before any commentary, then grade_attempt." +
            (autoAdvance
              ? " After grading, immediately call get_next_drill and ask the new question — do not wait for me."
              : " After grading, stop; the host app controls when the next drill starts.") +
            pressureClause,
        },
      });
    },
    [send],
  );

  const start = useCallback(async (
    initialDrill?: string,
    opts: {
      pressure?: boolean;
      attemptId?: string;
      settings?: RealtimeSettings;
      autoAdvance?: boolean;
    } = {},
  ) => {
    setError(null);
    setTranscript("");
    setAgentTranscript("");
    setMessages([]);
    transcriptItemsRef.current.clear();
    agentTranscriptItemsRef.current.clear();
    messagesRef.current.clear();
    setStatus("connecting");
    resetDebug();
    setDebugEvents([...getDebug().events]);
    try {
      recordDebugEvent("token.request");
      syncDebugEvents();
      const token = await api.realtimeToken(opts.settings);
      modelRef.current = token.model;
      recordDebugEvent("token.ok", {
        state: `${token.model}/${token.voice}`,
      });
      syncDebugEvents();
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        recordDebugStatus(`pc:${pc.connectionState}`);
      };
      pc.oniceconnectionstatechange = () => {
        recordDebugEvent("iceconnectionstatechange", {
          state: pc.iceConnectionState,
        });
      };
      pc.onicecandidateerror = (ev) => {
        recordDebugError(`ICE candidate error ${ev.errorCode}`);
      };

      // Inbound audio from the model → <audio> element.
      pc.ontrack = (ev) => {
        recordDebugEvent("track", { state: ev.track.kind });
        const audio = audioElRef.current;
        const stream = ev.streams[0];
        if (audio && stream) {
          audio.srcObject = stream;
          audio.muted = false;
          audio.volume = 1;
          audio.play().catch((err) => {
            recordDebugError(`audio playback failed: ${(err as Error).message}`);
          });
        }
      };

      // Microphone.
      const rawMic = shouldDisableMicProcessing();
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: rawMic
          ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            }
          : true,
      });
      recordDebugEvent("getUserMedia.ok", {
        state: rawMic ? "raw" : "default",
      });
      micStreamRef.current = mic;
      for (const track of mic.getTracks()) {
        pc.addTrack(track, mic);
      }

      // Mic-level meter: sample RMS at ~10 Hz so the UI can prove the
      // mic is alive. The AudioContext + AnalyserNode runs alongside
      // the WebRTC sender (it does not steal the track).
      try {
        const audioWindow = window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        };
        const Ctor = window.AudioContext ?? audioWindow.webkitAudioContext;
        if (Ctor) {
          const ctx = new Ctor();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(mic);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          const buf = new Uint8Array(analyser.fftSize);
          const tick = () => {
            if (!audioCtxRef.current) return;
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] ?? 128) - 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length) / 128;
            setMicLevel(Math.min(1, rms * 2));
            micLevelRafRef.current = window.setTimeout(tick, 100) as unknown as number;
          };
          tick();
        }
      } catch (err) {
        // Mic metering is a nice-to-have; never block the call on a
        // Web Audio failure.
        recordDebugError(`mic meter setup failed: ${(err as Error).message}`);
      }

      // Data channel for tool/event messages.
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        setStatus("connected");
        recordDebugStatus("connected");
        if (initialDrill) {
          pushDrill(initialDrill, opts);
        } else {
          send({
            type: "response.create",
            response: {
              instructions:
                "Greet me in one sentence and tell me to click Start to pick a drill. Do not pre-explain.",
            },
          });
        }
      };
      dc.onclose = () => recordDebugStatus("datachannel:closed");
      dc.onerror = () => recordDebugError("data channel error");

      dc.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data) as RealtimeServerEvent;
          recordDebugEvent(ev.type ?? "server_event", {
            deltaLength:
              typeof ev.delta === "string" ? ev.delta.length : undefined,
            transcriptLength:
              typeof ev.transcript === "string"
                ? ev.transcript.length
                : undefined,
          });
          if (ev.type === "error") {
            recordDebugError(ev.error?.message ?? "Realtime server error");
          }
          handleEvent(
            ev,
            transcriptItemsRef,
            setTranscript,
            messagesRef,
            setMessages,
          );
          handleAgentTranscriptEvent(
            ev,
            agentTranscriptItemsRef,
            setAgentTranscript,
            messagesRef,
            setMessages,
          );
          const usageEvent = usageEventFromServerEvent(ev, modelRef.current);
          if (usageEvent) {
            recordDebugEvent("usage.observed", {
              state: usageEvent.source,
              deltaLength: usageEvent.usage.total_tokens,
            });
            void usageHandlerRef.current?.(usageEvent);
          }
          if (
            ev.type === "output_audio_buffer.started" ||
            ev.type === "response.output_audio_transcript.delta"
          ) {
            setIsAgentSpeaking(true);
          }
          if (
            ev.type === "response.output_audio.done" ||
            ev.type === "response.output_audio_transcript.done" ||
            ev.type === "response.done"
          ) {
            setIsAgentSpeaking(false);
          }
          if (
            ev.type === "response.created" &&
            pendingAutoNextRef.current &&
            autoNextResponseIdRef.current === "__awaiting_created"
          ) {
            autoNextResponseIdRef.current = ev.response?.id ?? ev.response_id ?? "";
            recordDebugEvent("autoplay.verdict.started", {
              state: autoNextResponseIdRef.current || "unknown-response",
            });
          }
          const responseId = ev.response?.id ?? ev.response_id ?? "";
          if (
            ev.type === "response.done" &&
            pendingAutoNextRef.current &&
            autoNextResponseIdRef.current !== "__awaiting_created" &&
            (!autoNextResponseIdRef.current ||
              !responseId ||
              autoNextResponseIdRef.current === responseId)
          ) {
            pendingAutoNextRef.current = false;
            autoNextResponseIdRef.current = null;
            recordDebugEvent("autoplay.next.queued", { state: "1200ms" });
            autoNextTimerRef.current = window.setTimeout(() => {
              send({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text:
                        "Auto-advance now. Call get_next_drill and ask the new question.",
                    },
                  ],
                },
              });
              send({ type: "response.create" });
              recordDebugEvent("autoplay.next.sent");
            }, 1200) as unknown as number;
          }
          if (
            ev.type &&
            (ev.type === "response.output_item.added" ||
              ev.type === "response.output_item.done" ||
              ev.type === "response.function_call_arguments.done")
          ) {
            const debug = getDebug();
            debug.rawFunctionCallEvents ??= [];
            debug.rawFunctionCallEvents.push(ev);
            if (debug.rawFunctionCallEvents.length > 20) {
              debug.rawFunctionCallEvents.splice(
                0,
                debug.rawFunctionCallEvents.length - 20,
              );
            }
          }
          handleFunctionCallEvent(
            ev,
            pendingFunctionCallsRef,
            toolHandlerRef.current,
            send,
            () => {
              if (!autoAdvanceRef.current) return;
              pendingAutoNextRef.current = true;
              autoNextResponseIdRef.current = "__awaiting_created";
            },
            () => autoAdvanceRef.current,
          );
        } catch {
          /* non-JSON, ignore */
        }
      };

      // SDP offer → /v1/realtime/calls with ephemeral token.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      recordDebugEvent("sdp.offer.created");
      syncDebugEvents();

      const sdpResp = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(token.model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.client_secret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp ?? "",
        },
      );
      if (!sdpResp.ok) {
        const text = await sdpResp.text();
        recordDebugEvent("sdp.error", {
          statusCode: sdpResp.status,
          requestId:
            sdpResp.headers.get("x-request-id") ??
            sdpResp.headers.get("openai-request-id"),
        });
        throw new Error(
          `OpenAI WebRTC call failed (${sdpResp.status}): ${text.slice(0, 300)}`,
        );
      }
      const answer = { type: "answer" as const, sdp: await sdpResp.text() };
      await pc.setRemoteDescription(answer);
      recordDebugEvent("sdp.ok");
      syncDebugEvents();
    } catch (err) {
      if (isApiError(err)) {
        recordDebugEvent("api.error", {
          statusCode: err.status,
          requestId: err.requestId,
          openaiRequestId: err.openaiRequestId,
          retryable: err.retryable,
        });
      }
      const message = formatRealtimeError(err);
      recordDebugError(message);
      await closeRealtime();
      setError(message);
      setStatus("error");
      syncDebugEvents();
    }
  }, [closeRealtime, pushDrill, send, syncDebugEvents]);

  useEffect(() => {
    if (unmountStopTimerRef.current !== null) {
      window.clearTimeout(unmountStopTimerRef.current);
      unmountStopTimerRef.current = null;
    }
    return () => {
      unmountStopTimerRef.current = window.setTimeout(() => {
        void stop();
      }, 1000) as unknown as number;
    };
  }, [stop]);

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

/**
 * Resolve the (call_id, name) → arguments → dispatch flow across the
 * several events the GA Realtime API splits a function call into:
 *
 *   response.output_item.added   { item: { type: "function_call", name, call_id } }
 *   response.function_call_arguments.delta  { item_id, delta }
 *   response.function_call_arguments.done   { item_id, call_id, arguments }
 *   response.output_item.done    { item: { type: "function_call", call_id, arguments } }
 *
 * Some payloads carry the function name only on `output_item.*`, so we
 * track (item_id → { name, call_id }) and dispatch on the first event that
 * gives us complete arguments.
 */
function handleFunctionCallEvent(
  ev: RealtimeServerEvent,
  pendingRef: {
    current: Map<string, { name: string; call_id: string; dispatched: boolean }>;
  },
  handler: RealtimeToolHandler | null,
  send: (event: Record<string, unknown>) => void,
  scheduleAutoNext: () => void,
  shouldAutoAdvance: () => boolean,
): void {
  if (
    ev.type === "response.output_item.added" &&
    ev.item?.type === "function_call" &&
    ev.item.id &&
    ev.item.name &&
    ev.item.call_id
  ) {
    pendingRef.current.set(ev.item.id, {
      name: ev.item.name,
      call_id: ev.item.call_id,
      dispatched: false,
    });
    return;
  }

  if (ev.type === "response.function_call_arguments.done" && ev.item_id) {
    const pending = pendingRef.current.get(ev.item_id);
    const name = pending?.name ?? ev.name;
    const callId = pending?.call_id ?? ev.call_id;
    if (!name || !callId) return;
    if (pending?.dispatched) return;
    if (pending) pending.dispatched = true;
    void runToolCall(
      {
        name,
        call_id: callId,
        arguments: safeParseArgs(ev.arguments),
      },
      handler,
      send,
      scheduleAutoNext,
      shouldAutoAdvance,
    );
    return;
  }

  if (
    ev.type === "response.output_item.done" &&
    ev.item?.type === "function_call" &&
    ev.item.id &&
    ev.item.name &&
    ev.item.call_id
  ) {
    const pending = pendingRef.current.get(ev.item.id);
    if (pending?.dispatched) return;
    if (pending) pending.dispatched = true;
    void runToolCall(
      {
        name: ev.item.name,
        call_id: ev.item.call_id,
        arguments: safeParseArgs(ev.item.arguments),
      },
      handler,
      send,
      scheduleAutoNext,
      shouldAutoAdvance,
    );
  }
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function usageEventFromServerEvent(
  ev: RealtimeServerEvent,
  fallbackModel: string | null,
): RealtimeUsageEvent | null {
  if (ev.type === "response.done" && ev.response?.usage) {
    return {
      source: "realtime_response",
      model: ev.response.model ?? fallbackModel,
      response_id: ev.response.id ?? ev.response_id ?? null,
      usage: usageTotalsFromRaw(ev.response.usage, ev.response.model ?? fallbackModel),
    };
  }
  if (
    ev.type === "conversation.item.input_audio_transcription.completed" &&
    ev.usage
  ) {
    return {
      source: "realtime_transcription",
      model: fallbackModel,
      response_id: ev.item_id ? `transcription:${ev.item_id}` : null,
      usage: usageTotalsFromRaw(ev.usage, fallbackModel),
    };
  }
  return null;
}

function usageTotalsFromRaw(
  raw: Record<string, unknown>,
  model: string | null,
): RealtimeUsageEvent["usage"] {
  const inputDetails = usageRecord(raw.input_token_details);
  const outputDetails = usageRecord(raw.output_token_details);
  return {
    events: 1,
    model,
    response_id: null,
    input_tokens: usageNumber(raw.input_tokens),
    output_tokens: usageNumber(raw.output_tokens),
    total_tokens: usageNumber(raw.total_tokens),
    input_text_tokens: usageNumber(inputDetails.text_tokens),
    input_audio_tokens: usageNumber(inputDetails.audio_tokens),
    cached_tokens: usageNumber(inputDetails.cached_tokens),
    output_text_tokens: usageNumber(outputDetails.text_tokens),
    output_audio_tokens: usageNumber(outputDetails.audio_tokens),
    estimated_cost_usd: null,
    raw_usage: raw,
  };
}

function usageRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function usageNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

async function runToolCall(
  call: RealtimeToolCall,
  handler: RealtimeToolHandler | null,
  send: (event: Record<string, unknown>) => void,
  scheduleAutoNext: () => void,
  shouldAutoAdvance: () => boolean,
): Promise<void> {
  let output: Record<string, unknown>;
  try {
    output = handler
      ? await handler(call)
      : { error: "no tool handler registered on client" };
  } catch (err) {
    output = { error: (err as Error).message };
  }
  recordDebugEvent("tool_call.handled", {
    state: call.name,
    deltaLength: JSON.stringify(output).length,
  });
  const debug = getDebug();
  debug.toolCalls ??= [];
  debug.toolCalls.push({
    type: "tool_call.handled",
    at: Date.now(),
    state: call.name,
    deltaLength: JSON.stringify(output).length,
  });
  if (debug.toolCalls.length > 50) {
    debug.toolCalls.splice(0, debug.toolCalls.length - 50);
  }
  send({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(output),
    },
  });

  // After grading, the agent often wants to speak the verdict and then stop.
  // Inject a faux user message asking for the next drill, so the model picks
  // back up and calls get_next_drill on the *next* response cycle. This is
  // a belt-and-suspenders backstop on the Playground prompt (LOCAL.md §18 —
  // backend owns curriculum, agent drives it).
  if (
    call.name === "grade_attempt" &&
    !output.error &&
    shouldAutoAdvance() &&
    !window.__drillSuppressAutoNextDrill
  ) {
    send({
      type: "response.create",
      response: {
        instructions:
          "Say one short grading sentence only. Do not read the full rubric or cards aloud; the UI is showing those details.",
      },
    });
    scheduleAutoNext();
    recordDebugEvent("autoplay.next.backstop", { state: "after response.done" });
    return;
  }

  send({ type: "response.create" });
}

function handleEvent(
  ev: RealtimeServerEvent,
  transcriptItemsRef: { current: Map<string, string> },
  setTranscriptText: (text: string) => void,
  messagesRef: { current: Map<string, RealtimeMessage> },
  setMessages: (messages: RealtimeMessage[]) => void,
): void {
  // Accumulate user input audio transcript so we have something to grade.
  if (
    ev.type === "conversation.item.input_audio_transcription.completed" &&
    typeof ev.transcript === "string"
  ) {
    const itemId = ev.item_id ?? "__completed";
    transcriptItemsRef.current.set(itemId, ev.transcript);
    publishRealtimeMessage(messagesRef, setMessages, {
      id: `user:${itemId}`,
      role: "user",
      text: ev.transcript,
    });
    publishTranscript(transcriptItemsRef, setTranscriptText);
    return;
  }
  if (
    ev.type === "conversation.item.input_audio_transcription.delta" &&
    typeof ev.delta === "string"
  ) {
    const itemId = ev.item_id ?? "__streaming";
    const previous = transcriptItemsRef.current.get(itemId) ?? "";
    const next = previous + ev.delta;
    transcriptItemsRef.current.set(itemId, next);
    publishRealtimeMessage(messagesRef, setMessages, {
      id: `user:${itemId}`,
      role: "user",
      text: next,
    });
    publishTranscript(transcriptItemsRef, setTranscriptText);
  }
}

function publishTranscript(
  transcriptItemsRef: { current: Map<string, string> },
  setTranscriptText: (text: string) => void,
): void {
  setTranscriptText(
    Array.from(transcriptItemsRef.current.values()).filter(Boolean).join("\n"),
  );
}

/**
 * Captures the *agent's* spoken transcript (model TTS, not user mic) from
 * `response.output_audio_transcript.{delta,done}` events. Surfaced as
 * `agentTranscript` so the UI can show what the agent is saying even if
 * audio output is broken or muted. The same item_id may produce many
 * delta events and one done, so we accumulate per item.
 */
function handleAgentTranscriptEvent(
  ev: RealtimeServerEvent,
  agentTranscriptItemsRef: { current: Map<string, string> },
  setAgentTranscript: (text: string) => void,
  messagesRef: { current: Map<string, RealtimeMessage> },
  setMessages: (messages: RealtimeMessage[]) => void,
): void {
  if (
    ev.type === "response.output_audio_transcript.delta" &&
    typeof ev.delta === "string"
  ) {
    const itemId = ev.item_id ?? "__agent_streaming";
    const previous = agentTranscriptItemsRef.current.get(itemId) ?? "";
    const next = previous + ev.delta;
    agentTranscriptItemsRef.current.set(itemId, next);
    publishRealtimeMessage(messagesRef, setMessages, {
      id: `coach:${itemId}`,
      role: "coach",
      text: next,
    });
    publishTranscript(agentTranscriptItemsRef, setAgentTranscript);
    return;
  }
  if (
    ev.type === "response.output_audio_transcript.done" &&
    typeof ev.transcript === "string" &&
    ev.transcript.length > 0
  ) {
    // The done event carries the final, authoritative transcript for this
    // item — replace any partial deltas with it.
    const itemId = ev.item_id ?? "__agent_done";
    agentTranscriptItemsRef.current.set(itemId, ev.transcript);
    publishRealtimeMessage(messagesRef, setMessages, {
      id: `coach:${itemId}`,
      role: "coach",
      text: ev.transcript,
    });
    publishTranscript(agentTranscriptItemsRef, setAgentTranscript);
  }
}

function publishRealtimeMessage(
  messagesRef: { current: Map<string, RealtimeMessage> },
  setMessages: (messages: RealtimeMessage[]) => void,
  patch: { id: string; role: "coach" | "user"; text: string },
): void {
  const existing = messagesRef.current.get(patch.id);
  messagesRef.current.set(patch.id, {
    ...patch,
    at: existing?.at ?? Date.now(),
  });
  setMessages(
    Array.from(messagesRef.current.values())
      .filter((message) => message.text.trim().length > 0)
      .sort((a, b) => a.at - b.at),
  );
}

function shouldDisableMicProcessing(): boolean {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("debugMic") === "raw" ||
    import.meta.env.VITE_REALTIME_RAW_MIC === "1"
  );
}

function formatRealtimeError(err: unknown): string {
  if (!isApiError(err)) return (err as Error).message;
  const parts = [err.message];
  if (err.openaiRequestId) parts.push(`OpenAI request ${err.openaiRequestId}`);
  if (err.requestId) parts.push(`local request ${err.requestId}`);
  if (err.retryable) parts.push("retryable");
  return parts.join(" · ");
}

function buildRealtimeSessionUpdate(settings: RealtimeSettings): Record<string, unknown> {
  return {
    audio: {
      input: {
        turn_detection: buildTurnDetection(settings),
      },
      output: {
        speed: clamp(settings.voice_speed, 0.25, 1.5),
      },
    },
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: {
        post_instructions: 4000,
      },
    },
  };
}

function buildTurnDetection(settings: RealtimeSettings): Record<string, unknown> {
  if (settings.vad.mode === "semantic_vad") {
    return {
      type: "semantic_vad",
      eagerness: settings.vad.eagerness,
      create_response: true,
      interrupt_response: settings.vad.interrupt_response,
    };
  }
  return {
    type: "server_vad",
    threshold: clamp(settings.vad.threshold, 0, 1),
    prefix_padding_ms: clamp(settings.vad.prefix_padding_ms, 0, 3000),
    silence_duration_ms: clamp(settings.vad.silence_duration_ms, 100, 5000),
    create_response: true,
    interrupt_response: settings.vad.interrupt_response,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function getDebug(): RealtimeDebug {
  window.__drillRealtimeDebug ??= { status: "idle", events: [], errors: [] };
  return window.__drillRealtimeDebug;
}

function resetDebug(): void {
  window.__drillRealtimeDebug = {
    status: "connecting",
    events: [],
    toolCalls: [],
    errors: [],
  };
  recordDebugEvent("status", { state: "connecting" });
}

function recordDebugStatus(status: string): void {
  getDebug().status = status;
  recordDebugEvent("status", { state: status });
}

function recordDebugError(message: string): void {
  const debug = getDebug();
  debug.status = "error";
  debug.errors.push(message);
  recordDebugEvent("error", { message });
}

function recordDebugEvent(
  type: string,
  details: Omit<RealtimeDebugEvent, "type" | "at"> = {},
): void {
  const debug = getDebug();
  debug.events.push({ type, at: Date.now(), ...details });
  if (debug.events.length > 500) {
    debug.events.splice(0, debug.events.length - 500);
  }
}
