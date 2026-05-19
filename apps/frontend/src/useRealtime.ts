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

export interface RealtimeHandle {
  status: Status;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  transcript: string;
  audioEl: React.RefObject<HTMLAudioElement | null>;
  send: (event: Record<string, unknown>) => void;
}

export function useRealtime(): RealtimeHandle {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const send = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(event));
  }, []);

  const stop = useCallback(async () => {
    setStatus("stopping");
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
    setStatus("idle");
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setTranscript("");
    setStatus("connecting");
    try {
      const token = await api.realtimeToken();
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Inbound audio from the model → <audio> element.
      pc.ontrack = (ev) => {
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
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = mic;
      for (const track of mic.getTracks()) {
        pc.addTrack(track, mic);
      }

      // Data channel for tool/event messages.
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        setStatus("connected");
        // Trigger an opening message from the model.
        send({
          type: "response.create",
          response: {
            instructions:
              "Greet me in one sentence, then call the get_next_drill tool to fetch a drill and ask it aloud. Do not pre-explain.",
          },
        });
      };

      dc.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          handleEvent(ev, setTranscript);
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
      setError((err as Error).message);
      setStatus("error");
      await stop();
    }
  }, [send, stop]);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  return { status, error, start, stop, transcript, audioEl: audioElRef, send };
}

function handleEvent(
  ev: { type?: string; transcript?: string; delta?: string },
  setTranscript: (updater: (prev: string) => string) => void,
): void {
  // Accumulate user input audio transcript so we have something to grade.
  if (
    ev.type === "conversation.item.input_audio_transcription.completed" &&
    typeof ev.transcript === "string"
  ) {
    const text = ev.transcript;
    setTranscript((prev) => (prev ? `${prev}\n${text}` : text));
    return;
  }
  if (
    ev.type === "conversation.item.input_audio_transcription.delta" &&
    typeof ev.delta === "string"
  ) {
    setTranscript((prev) => prev + ev.delta);
  }
}
