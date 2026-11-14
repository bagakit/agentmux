import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { base64EncryptedWireByteLength } from "../src/encrypted-channel.js";
import {
  createEncryptedRelaySocket,
  ENCRYPTED_RELAY_HIGH_WATER_MARK,
  type EncryptedRelayChannel,
} from "../src/encrypted-relay-socket.js";

const MiB = 1024 * 1024;
const RPC_MAX_FRAME_BYTES = 64 * MiB;

// The transport buffer is explicit: every handed frame adds its wire bytes until the test drains it.
function harness(initialBuffered = 0) {
  const handed: string[] = [];
  const drains: Array<() => void> = [];
  const state = { buffered: initialBuffered, terminated: false, closed: false };
  const emitter = new EventEmitter();
  emitter.on("error", () => {});
  const wire = (data: string | ArrayBuffer) =>
    base64EncryptedWireByteLength(typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);
  const channel: EncryptedRelayChannel = {
    setState: () => {},
    send: async (data) => {
      handed.push(typeof data === "string" ? data.slice(0, 16) : `bytes:${data.byteLength}`);
      state.buffered += wire(data);
    },
    outboundWireByteLength: wire,
    close: () => { state.closed = true; },
  };
  const socket = createEncryptedRelaySocket({
    channel, emitter,
    getTransportBufferedAmount: () => state.buffered,
    terminateTransport: () => { state.terminated = true; },
    waitForTransportDrain: () => new Promise<void>((resolve) => drains.push(resolve)),
  });
  const drainTo = async (bytes: number) => {
    state.buffered = bytes;
    for (const resolve of drains.splice(0)) resolve();
    await settle();
  };
  return { socket, handed, drains, state, emitter, drainTo };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const outcome = (sending: void | Promise<void>) =>
  Promise.resolve(sending).then(() => "sent", (error: Error) => error.message);

it("hands one maximal protocol frame to an idle transport without terminating", async () => {
  const { socket, handed, state } = harness();
  const frame = new ArrayBuffer(RPC_MAX_FRAME_BYTES);
  expect(base64EncryptedWireByteLength(RPC_MAX_FRAME_BYTES)).toBeGreaterThan(ENCRYPTED_RELAY_HIGH_WATER_MARK);
  expect(await outcome(socket.send(frame))).toBe("sent");
  expect(handed).toEqual([`bytes:${RPC_MAX_FRAME_BYTES}`]);
  expect(state.terminated).toBe(false);
  expect(socket.readyState).toBe(1);
});

it("hands a frame whose size plus the queued bytes exceeds the high-water mark while the buffer is below it", async () => {
  const { socket, handed, state } = harness(6 * MiB);
  expect(await outcome(socket.send("x".repeat(4 * MiB)))).toBe("sent");
  expect(handed).toHaveLength(1);
  expect(state.terminated).toBe(false);
});

it("hands a frame at the exact high-water mark without waiting for another drain", async () => {
  const { socket, handed, drains, state } = harness(ENCRYPTED_RELAY_HIGH_WATER_MARK);
  expect(await outcome(socket.send("boundary"))).toBe("sent");
  expect(handed).toEqual(["boundary"]);
  expect(drains).toHaveLength(0);
  expect(state.terminated).toBe(false);
});

it("waits above the high-water mark, then hands every waiting frame in FIFO order", async () => {
  const { socket, handed, drains, state, drainTo } = harness(ENCRYPTED_RELAY_HIGH_WATER_MARK + 1);
  const results = ["first", "second", "third"].map((name) => outcome(socket.send(`${name}:${"y".repeat(3 * MiB)}`)));
  await settle();
  expect(handed).toEqual([]);
  expect(drains).toHaveLength(1);
  expect(state.terminated).toBe(false);

  await drainTo(0);
  // Below the mark one frame (any size) is handed; later frames wait for the next drain.
  expect(handed.length).toBeGreaterThanOrEqual(1);
  while (handed.length < 3) await drainTo(0);
  expect(handed.map((frame) => frame.split(":")[0])).toEqual(["first", "second", "third"]);
  expect(await Promise.all(results)).toEqual(["sent", "sent", "sent"]);
  expect(state.terminated).toBe(false);
});

it("a slow reader keeps the producer waiting instead of rejecting or closing", async () => {
  const { socket, handed, state, drainTo } = harness(ENCRYPTED_RELAY_HIGH_WATER_MARK + 1);
  let settled = false;
  const producers = Array.from({ length: 8 }, (_, index) => outcome(socket.send(`frame-${index}:${"z".repeat(2 * MiB)}`)));
  void Promise.all(producers).then(() => { settled = true; });
  for (let round = 0; round < 5; round++) await settle();
  expect(settled).toBe(false);
  expect(handed).toEqual([]);
  expect(state.terminated || state.closed).toBe(false);
  while (handed.length < producers.length) await drainTo(0);
  expect(await Promise.all(producers)).toEqual(producers.map(() => "sent"));
  expect(handed.map((frame) => frame.split(":")[0])).toEqual(producers.map((_, index) => `frame-${index}`));
});

it("a transport that ends during the wait rejects the waiting frames without sending them", async () => {
  const { socket, handed, state, emitter } = harness(ENCRYPTED_RELAY_HIGH_WATER_MARK + 1);
  const waiting = outcome(socket.send("pending"));
  await settle();
  emitter.emit("close", 1006, "");
  expect(await waiting).toMatch(/closed before its frame was sent/);
  expect(handed).toEqual([]);
  expect(state.terminated).toBe(false);
  expect(await outcome(socket.send("after"))).toMatch(/not open/);
});
