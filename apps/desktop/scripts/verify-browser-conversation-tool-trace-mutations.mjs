import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const component = 'apps/desktop/src/renderer/src/components/ConversationToolTrace.tsx'
const message = 'apps/desktop/src/renderer/src/components/ConversationMessage.tsx'
await verifyRendererSourceMutations({
  name: 'conversation-tool-trace-mutations',
  tests: ['apps/desktop/test/conversation-tool-trace.test.tsx', 'apps/desktop/test/conversation-native-trace.test.tsx'],
  sources: [component, message, 'apps/desktop/src/renderer/src/styles/conversation-tool-trace.css'],
  mutations: [
    { label: 'eager-payload', file: component, before: '{open ? <div', after: '{true ? <div' },
    { label: 'call-identity-lost', file: message, before: 'if (callCounts.get(k) === 1) return k', after: 'if (callCounts.get(k) === 1) return `${k}:${nextLocalKeyRef.current++}`' },
    { label: 'failure-hidden', file: component, before: "const failed = part.kind === 'tool-result' && part.failed === true", after: 'const failed = false' }
  ]
})
