// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0.
// Adapted from Paseo 3c6e4e39ec57fc1ecec35cd848ba259893d5e298: local imports and AgentMux RPC metadata.
import { EventEmitter } from "node:events";

/**
 * In-flight memory budget of one encrypted relay socket. These bound memory, never frame size:
 * a protocol-legal frame of any size is handed to the transport once the buffer is at or below
 * the high-water mark, and frames waiting for room keep their producer waiting.
 */
export const ENCRYPTED_RELAY_HIGH_WATER_MARK = 8 * 1024 * 1024;
export const ENCRYPTED_RELAY_SEND_QUEUE_BYTES = 8 * 1024 * 1024;

export interface EncryptedRelayChannel {
  setState: (state: "open") => void;
  send: (data: string | ArrayBuffer) => Promise<void>;
  outboundWireByteLength: (data: string | ArrayBuffer) => number;
  close: (code?: number, reason?: string) => void;
}

export interface EncryptedRelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  /** Await completion before producing the next frame; this is the transport backpressure boundary. */
  send: (data: string | Uint8Array | ArrayBuffer) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

type QueuedFrame = { outbound: string | ArrayBuffer; bytes: number; resolve: () => void; reject: (error: Error) => void };

export function createEncryptedRelaySocket(params: {
  channel: EncryptedRelayChannel;
  emitter: EventEmitter;
  getTransportBufferedAmount: () => number | undefined;
  terminateTransport: () => void;
  /** Resolves once the transport has drained below the high-water mark, or is no longer open. */
  waitForTransportDrain: () => Promise<void>;
}): EncryptedRelaySocket {
  const { channel, emitter, getTransportBufferedAmount, terminateTransport, waitForTransportDrain } = params;
  let readyState = 1;
  const queue: QueuedFrame[] = [];
  const roomWaiters: Array<() => void> = [];
  let queuedBytes = 0, pumping = false, admission = Promise.resolve();

  channel.setState("open");

  const wakeRoom = () => { for (const wake of roomWaiters.splice(0)) wake(); };
  const ended = () => {
    readyState = 3;
    const error = new Error("Encrypted relay socket closed before its frame was sent");
    for (const frame of queue.splice(0)) frame.reject(error);
    queuedBytes = 0;
    wakeRoom();
  };

  const terminate = () => {
    if (readyState === 3) return;
    ended();
    terminateTransport();
  };

  const close = (code?: number, reason?: string) => {
    if (readyState === 3) return;
    ended();
    channel.close(code, reason);
  };

  emitter.on("close", ended);

  // The Core finite dispatcher and subscription drain await send before producing the next frame.
  // One pump hands admitted frames to the channel strictly in order. channel.send() reaches the
  // transport synchronously, so the transport buffer sees the same order without awaiting each write.
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && readyState === 1) {
        // A transport that stopped being open also ends the wait; the next send then fails on it.
        if ((getTransportBufferedAmount() ?? 0) > ENCRYPTED_RELAY_HIGH_WATER_MARK) await waitForTransportDrain();
        if (readyState !== 1 || !queue.length) break;
        const frame = queue.shift()!;
        queuedBytes -= frame.bytes;
        wakeRoom();
        channel.send(frame.outbound).then(frame.resolve, (error) => {
          emitter.emit("error", error);
          frame.reject(error);
        });
      }
    } finally {
      pumping = false;
    }
  };

  return {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return getTransportBufferedAmount() ?? 0;
    },
    send: (data) => {
      if (readyState !== 1) {
        return Promise.reject(new Error("Encrypted relay socket is not open"));
      }
      // Keep the existing Uint8Array snapshot semantics at the call boundary.
      // The production Host sends immutable JSON strings and awaits each send.
      const outbound = normalizeRelaySendPayload(data);
      const bytes = channel.outboundWireByteLength(outbound);
      return new Promise<void>((resolve, reject) => {
        admission = admission.then(async () => {
          // A full queue makes the producer wait; one frame larger than the queue budget is admitted alone.
          while (readyState === 1 && queue.length && queuedBytes + bytes > ENCRYPTED_RELAY_SEND_QUEUE_BYTES) {
            await new Promise<void>((wake) => roomWaiters.push(wake));
          }
          if (readyState !== 1) {
            reject(new Error("Encrypted relay socket closed before its frame was sent"));
            return;
          }
          queue.push({ outbound, bytes, resolve, reject });
          queuedBytes += bytes;
          void pump();
        });
      });
    },
    close,
    terminate,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    once: (event, listener) => {
      emitter.once(event, listener);
    },
  };
}

function normalizeRelaySendPayload(data: string | Uint8Array | ArrayBuffer): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out.buffer;
}
