import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api.ts";

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

export type RealtimeToolHandler = (
  call: RealtimeToolCall,
) => Promise<Record<string, unknown>>;

type RealtimeDebugEvent = {
  type: string;
  at: number;
  state?: string;
  message?: string;
  deltaLength?: number;
  transcriptLength?: number;
};

type RealtimeDebug = {
  status: string;
  events: RealtimeDebugEvent[];
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
    opts?: { pressure?: boolean },
  ) => Promise<void>;
  stop: () => Promise<void>;
  transcript: string;
  audioEl: React.RefObject<HTMLAudioElement | null>;
  send: (event: Record<string, unknown>) => void;
  pushDrill: (question: string, opts?: { pressure?: boolean }) => void;
  setToolHandler: (handler: RealtimeToolHandler | null) => void;
}

export function useRealtime(): RealtimeHandle {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const transcriptItemsRef = useRef<Map<string, string>>(new Map());
  const toolHandlerRef = useRef<RealtimeToolHandler | null>(null);
  const pendingFunctionCallsRef = useRef<
    Map<string, { name: string; call_id: string; dispatched: boolean }>
  >(new Map());

  const setToolHandler = useCallback((handler: RealtimeToolHandler | null) => {
    toolHandlerRef.current = handler;
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
    dcRef.current = null;
    pcRef.current = null;
    micStreamRef.current = null;
  }, []);

  const stop = useCallback(async () => {
    setStatus("stopping");
    recordDebugStatus("stopping");
    await closeRealtime();
    setStatus("idle");
    recordDebugStatus("idle");
  }, [closeRealtime]);

  const pushDrill = useCallback(
    (question: string, opts: { pressure?: boolean } = {}) => {
      if (!question) return;
      const pressureClause = opts.pressure
        ? "\n\nPRESSURE MODE: interrupt rambling after ~10 seconds. If the user stalls, snap 'Default answer now.' Be sharper, shorter, more critical than usual. Force at least one pressure follow-up regardless of answer quality."
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
                pressureClause,
            },
          ],
        },
      });
      send({
        type: "response.create",
        response: {
          instructions:
            "Ask the current drill question above in one breath, then stop and wait for the user's answer. Do not give hints. After grading the answer, immediately call get_next_drill and ask the new question — do not wait for me." +
            pressureClause,
        },
      });
    },
    [send],
  );

  const start = useCallback(async (
    initialDrill?: string,
    opts: { pressure?: boolean } = {},
  ) => {
    setError(null);
    setTranscript("");
    transcriptItemsRef.current.clear();
    setStatus("connecting");
    resetDebug();
    try {
      const token = await api.realtimeToken();
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
          audio.play().catch(() => {
            /* user gesture probably required; we already had one */
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
          handleEvent(ev, transcriptItemsRef, setTranscript);
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
          );
        } catch {
          /* non-JSON, ignore */
        }
      };

      // SDP offer → /v1/realtime/calls with ephemeral token.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

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
        throw new Error(
          `OpenAI WebRTC call failed (${sdpResp.status}): ${text.slice(0, 300)}`,
        );
      }
      const answer = { type: "answer" as const, sdp: await sdpResp.text() };
      await pc.setRemoteDescription(answer);
    } catch (err) {
      const message = (err as Error).message;
      recordDebugError(message);
      await closeRealtime();
      setError(message);
      setStatus("error");
    }
  }, [closeRealtime, pushDrill, send]);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  return {
    status,
    error,
    start,
    stop,
    transcript,
    audioEl: audioElRef,
    send,
    pushDrill,
    setToolHandler,
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

async function runToolCall(
  call: RealtimeToolCall,
  handler: RealtimeToolHandler | null,
  send: (event: Record<string, unknown>) => void,
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
    !window.__drillSuppressAutoNextDrill
  ) {
    send({ type: "response.create" });
    setTimeout(() => {
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Next drill, please. Call get_next_drill and ask the new question.",
            },
          ],
        },
      });
      send({ type: "response.create" });
    }, 2500);
    return;
  }

  send({ type: "response.create" });
}

function handleEvent(
  ev: RealtimeServerEvent,
  transcriptItemsRef: { current: Map<string, string> },
  setTranscriptText: (text: string) => void,
): void {
  // Accumulate user input audio transcript so we have something to grade.
  if (
    ev.type === "conversation.item.input_audio_transcription.completed" &&
    typeof ev.transcript === "string"
  ) {
    transcriptItemsRef.current.set(ev.item_id ?? "__completed", ev.transcript);
    publishTranscript(transcriptItemsRef, setTranscriptText);
    return;
  }
  if (
    ev.type === "conversation.item.input_audio_transcription.delta" &&
    typeof ev.delta === "string"
  ) {
    const itemId = ev.item_id ?? "__streaming";
    const previous = transcriptItemsRef.current.get(itemId) ?? "";
    transcriptItemsRef.current.set(itemId, previous + ev.delta);
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

function shouldDisableMicProcessing(): boolean {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("debugMic") === "raw" ||
    import.meta.env.VITE_REALTIME_RAW_MIC === "1"
  );
}

function getDebug(): RealtimeDebug {
  window.__drillRealtimeDebug ??= { status: "idle", events: [], errors: [] };
  return window.__drillRealtimeDebug;
}

function resetDebug(): void {
  window.__drillRealtimeDebug = {
    status: "connecting",
    events: [],
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
  if (debug.events.length > 100) {
    debug.events.splice(0, debug.events.length - 100);
  }
}
