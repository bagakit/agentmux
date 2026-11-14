export const gatewayMutations = {
  'wrong-publisher-credential': {
    file: 'packages/relay/src/publisher-admission.ts',
    test: 'packages/relay/test/routing-server.test.ts',
    target: 'requires the exact publisher credential',
    before: "return timingSafeEqual(expected, createHash('sha256').update(received).digest())",
    after: 'return true',
  },
  'foreign-data-route': {
    file: 'packages/relay/src/routing-server.ts',
    test: 'packages/relay/test/routing-server.test.ts',
    target: 'a data route belongs only to its original server',
    before: 'const pair = id ? route.pairs.get(id) : undefined',
    after: 'const pair = id ? [...routes.values()].map(value => value.pairs.get(id)).find(Boolean) : undefined',
  },
  'replace-healthy-publisher': {
    file: 'packages/relay/src/routing-server.ts',
    test: 'packages/relay/test/routing-server.test.ts',
    target: 'requires the exact publisher credential',
    before: "if (options.publisherCollision === 'reject' && role === 'server' &&",
    after: "if (false && role === 'server' &&",
  },
  'remove-local-admission': {
    file: 'packages/relay/src/local-adapter.ts',
    test: 'packages/relay/test/local-identifiers.test.ts',
    target: 'local Relay allocates a shared pair ID',
    before: "request.headers.authorization === `Bearer ${controlToken}`",
    after: 'true',
  },
}
