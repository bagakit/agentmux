import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const component = 'apps/desktop/src/renderer/src/components/ConversationToolTrace.tsx'
const message = 'apps/desktop/src/renderer/src/components/ConversationMessage.tsx'
await verifyRendererSourceMutations({
  name: 'conversation-tool-trace-mutations',
  tests: ['apps/desktop/test/conversation-tool-trace.test.tsx', 'apps/desktop/test/conversation-native-trace.test.tsx'],
  sources: [component, message, 'apps/desktop/src/renderer/src/styles/conversation-tool-trace.css'],
  mutations: [
    { label: 'eager-payload', file: component, before: '{open ? <div', after: '{true ? <div' },
    { label: 'call-identity-lost', file: message, before: 'return JSON.stringify([part.kind, callId, occ])', after: 'return JSON.stringify([part.kind, null, occ])' },
    { label: 'failure-hidden', file: component, before: "const failed = part.kind === 'tool-result' && part.failed === true", after: 'const failed = false' }
  ]
})
