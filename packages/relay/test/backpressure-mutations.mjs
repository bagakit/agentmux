export const backpressureMutations = {
  'host-frame-is-budget': {
    file: 'packages/relay/src/encrypted-relay-socket.ts',
    test: 'packages/relay/test/encrypted-relay-socket.test.ts',
    target: 'hands one maximal protocol frame to an idle transport without terminating',
    before: '        const frame = queue.shift()!;',
    after: '        if ((getTransportBufferedAmount() ?? 0) + queue[0]!.bytes > ENCRYPTED_RELAY_HIGH_WATER_MARK) { terminate(); return; }\n        const frame = queue.shift()!;'
  },
  'relay-close-slow-reader': {
    file: 'packages/relay/src/routing-server.ts',
    test: 'packages/relay/test/local-relay-backpressure.test.ts',
    target: 'a paused reader pauses its source instead of closing, and receives everything in order after resuming',
    before: '    forwarded.set(target, (forwarded.get(target) ?? 0) + byteLength(data))',
    after: "    if (target.bufferedAmount > 8 * 1024 * 1024) { target.close(4008, 'Reader exceeded its budget'); return }\n    forwarded.set(target, (forwarded.get(target) ?? 0) + byteLength(data))"
  },
  'client-uses-host-limit': {
    file: 'packages/relay/src/routing-server.ts',
    test: 'packages/relay/test/local-relay-role-limits.test.ts',
    target: 'rejects only the oversized client with data attached=true and preserves peer requests',
    before: 'maxPayload: CLIENT_SOCKET_MAX_PAYLOAD, perMessageDeflate: false',
    after: 'maxPayload: SERVER_SOCKET_MAX_PAYLOAD, perMessageDeflate: false'
  }
}
