import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const component = 'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx'
await verifyRendererSourceMutations({
  name: 'browser-trace-row-mutations',
  tests: ['apps/desktop/test/browser-trace-row.test.tsx', 'apps/desktop/test/browser-operation-surface.test.tsx', 'apps/desktop/test/browser-operation-pane-empty.test.tsx'],
  sources: [component, 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/styles/browser-operation-surface.css', 'apps/desktop/src/renderer/src/styles/browser.css'],
  mutations: [
    { label: 'eager-step-detail', file: component, before: '{open ? <div', after: '{true ? <div' },
    { label: 'eager-warning-diagnostics', file: component, before: '{open ? <pre id={panelId}>{message}</pre> : null}', after: '{true ? <pre id={panelId}>{message}</pre> : null}' },
    { label: 'failure-hidden', file: component, before: '<span className="browser-rsi-timeline__status">{step.status}</span>', after: '<span className="browser-rsi-timeline__status">{step.status === \'failed\' ? \'completed\' : step.status}</span>' },
    { label: 'selected-identity-lost', file: component, before: 'selected={selectedSequence === step.sequence}', after: 'selected={false}' },
    { label: 'duplicate-empty-activity', file: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', before: '{timelineOperation ? <BrowserOperationTimeline', after: '{true ? <BrowserOperationTimeline' }
  ]
})
