import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/renderer/src/hooks/useBrowserAnnotationMarkers.ts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
await verifyRendererSourceMutations({
  name: `browser-annotation-recovery-mutations-${Date.now()}`,
  tests: ['apps/desktop/test/browser-annotation-owner-recovery.test.tsx'],
  sources: [file, pane, 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/workbench-persistence.ts'],
  mutations: [
    { label: 'durable-shell-used-before-native-document', file,
      before: '!active || !navigationId || !nativeOwnerPresent()', after: '!active || !nativeOwnerPresent()' },
    { label: 'restore-pending-owner-is-written', file,
      before: '!active || !navigationId || !nativeOwnerPresent()', after: '!active || !navigationId' },
    { label: 'real-marker-failure-silently-ignored', file,
      before: 'setFailure({ subject, reason: presentError(error) })', after: 'void error' },
    { label: 'acknowledged-current-sync-cannot-clear-notice', file,
      before: '.then(() => { if (isCurrent()) setFailure(null) })', after: '.then(() => {})' },
    { label: 'retry-clears-notice-before-acknowledgement', file,
      before: 'const token = ++request.current', after: 'setFailure(null); const token = ++request.current' },
    { label: 'late-former-document-may-write-current-status', file,
      before: 'const isCurrent = (): boolean => token === request.current && latest.current.active &&\n      latest.current.browserId === browserId && latest.current.navigationId === navigationId && latest.current.nativeOwnerPresent()',
      after: 'const isCurrent = (): boolean => true' },
    { label: 'mounted-pane-local-service-consumer-disconnected', file: pane,
      before: 'const annotationSync = useBrowserAnnotationMarkers({\n    browserId: tab.browserId, navigationId: tab.navigationId, annotations,\n    active: !released && !restoring, nativeOwnerPresent: annotationOwnerPresent\n  })',
      after: 'const annotationSync = { notice: null, retryAvailable: false, retry() {} }' }
  ]
})
