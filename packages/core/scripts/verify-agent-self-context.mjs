import { runA2aProof } from './lib/a2a-proof.mjs'

const actual = ['packages/core/test/agent-self-context-rpc.test.ts']
await runA2aProof({
  name: 'agent-self-context-proof',
  tests: [...actual, 'packages/core/test/agent-self-context.test.ts'],
  sourceInputs: ['packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts',
    'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agent-self-context.ts',
    'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-wire.ts',
    'packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-commands.ts',
    'packages/core/test/helpers/public-rpc-owner.ts', 'packages/core/test/helpers/object-cli-rpc.ts',
    'packages/core/scripts/verify-agent-self-context.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AMX_SELF_CONTEXT_DIST: new URL('.', url('index.js')).href }),
  callers: [
    { symbol: "case 'whoami':", path: 'packages/core/src/public-rpc-service.ts' },
    { symbol: 'this.service.call', path: 'packages/core/src/public-rpc-wire.ts' },
    { symbol: 'new AgentMuxRpcDispatcher', path: 'packages/core/src/public-rpc-server.ts' },
    { symbol: 'parseRpcNativeResult(method, value, params, credentials)', path: 'packages/core/src/public-rpc-client.ts' },
    { symbol: "empty('whoami'", path: 'packages/core/src/agentmux-cli-commands.ts' },
    { symbol: 'client.call(method, invocation.params', path: 'packages/core/src/agentmux.ts' }
  ],
  mutations: [
    { label: 'static-guidance-reintroduced', file: 'public-rpc-service.js',
      before: 'result = { session: owner.session, status, view, unavailable: issues };',
      after: "result = { session: owner.session, status, view, topic: 'obsolete static guidance', unavailable: issues };", tests: actual },
    { label: 'full-status-native-failure-discarded', file: 'public-rpc-service.js',
      before: 'result = { session: owner.session, status, view, unavailable: issues };',
      after: 'if (status) delete status.session.semanticStatus; result = { session: owner.session, status, view, unavailable: issues };', tests: actual },
    { label: 'unknown-view-misreported-as-absent', file: 'agent-self-context.js',
      before: "return { attached: false, reason: 'view-unavailable', error: { code, message } };",
      after: "return { attached: false, reason: 'no-desktop-view' };", tests: actual },
    { label: 'sdk-accepts-obsolete-static-fields', file: 'rpc-native-codec.js',
      before: "method === 'whoami' ? ['session', 'status', 'view', 'unavailable']",
      after: "method === 'whoami' ? ['session', 'status', 'view', 'unavailable', 'topic', 'messaging']", tests: actual },
    { label: 'sdk-accepts-another-caller-identity', file: 'rpc-native-codec.js',
      before: "target.kind === 'self' && !rpcSessionTargetMatches('self', session.agentSessionId, credentials)",
      after: 'false', tests: actual }
  ]
})
