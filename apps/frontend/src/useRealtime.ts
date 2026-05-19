import { useCallback, useEffect, useRef, useState } from "react";
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
};

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
};

declare global {
  interface Window {
    __drillRealtimeDebug?: RealtimeDebug;
  }
}

export interface RealtimeHandle {
  status: Status;
  error: string | null;
  start: (initialDrill?: string) => Promise<void>;
  stop: () => Promise<void>;
  transcript: string;
  audioEl: React.RefObject<HTMLAudioElement | null>;
  send: (event: Record<string, unknown>) => void;
  pushDrill: (question: string) => void;
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

  const send = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(event));
  }, []);

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
    (question: string) => {
      if (!question) return;
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
                question.trim(),
            },
          ],
        },
      });
      send({
        type: "response.create",
        response: {
          instructions:
            "Ask the current drill question above in one breath, then stop and wait for the user's answer. Do not give hints.",
        },
      });
    },
    [send],
  );

  const start = useCallback(async (initialDrill?: string) => {
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
          pushDrill(initialDrill);
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
  };
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
