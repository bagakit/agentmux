const notificationTest = 'apps/desktop/test/integrated-notification-identifiers.test.ts'
const heapTest = 'apps/desktop/test/performance-heap-snapshot.test.tsx'
const profileTest = 'apps/desktop/test/mote-private-chat-profile.test.tsx'
export const integratedIdentityMutations = {
  'toolkit-invocation': { file: 'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx', before: 'invocationId: mintObjectId()', test: 'apps/desktop/test/toolkit-tui-ui.test.tsx' },
  'notification-request': { file: 'apps/desktop/src/main/notification-observation.ts', before: 'requestId: mintObjectId()', test: notificationTest },
  'notification-document': { file: 'apps/desktop/src/renderer/src/lib/notification-observation.ts', before: 'const instanceId = mintObjectId()', test: notificationTest },
  'heap-export': { file: 'apps/desktop/src/main/renderer-heap-snapshot.ts', before: '${mintObjectId()}', test: heapTest },
  'heap-capture': { file: 'apps/desktop/src/renderer/src/lib/use-performance-heap-snapshot.ts', before: 'captureId: mintObjectId()', test: heapTest },
  'chat-policy': { file: 'apps/desktop/src/renderer/src/components/MotePrivateChat.tsx', before: 'const operationId = mintObjectId()', test: profileTest },
  'chat-allowance': { file: 'apps/desktop/src/renderer/src/components/MoteChatPeople.tsx', before: 'operationId: mintObjectId()', test: profileTest },
  'identity-removal': { file: 'apps/desktop/src/renderer/src/components/settings/ConnectionIdentityRemoval.tsx', before: 'operationId: mintObjectId()', test: 'apps/desktop/test/connection-identity-library.test.tsx' },
  'chat-generation': { file: 'packages/connectors/src/mote-chat.ts', before: 'const id = mintObjectId()', test: 'packages/connectors/test/mote-chat-owner.test.ts' },
  'heap-capture-reader': { file: 'packages/core/src/renderer-heap-snapshot.ts',
    before: '/^[A-Za-z0-9_-]{1,128}$/u', after: '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u', test: heapTest },
  'heap-path-reader': { file: 'packages/core/src/renderer-heap-snapshot.ts', before: '/^[A-Za-z0-9_-]{1,128}$/u',
    after: '/^[\\s\\S]{1,128}$/u', test: 'apps/desktop/test/integrated-heap-identifiers.test.ts' }
}
