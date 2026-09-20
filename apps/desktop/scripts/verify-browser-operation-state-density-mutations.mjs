import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = 'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const status = `        <BrowserOperationStatus
          activity={browserActivity}
          onTakeControl={() => void stopBrowserOperation()}
          onStop={() => void stopBrowserOperation()}
          onReturnControl={() => void run(() => api.browser.returnControl(tab.browserId))}
          onOpenTimeline={openOperationTimeline}
          onOpenChange={setMenuOpen}
        />`

await verifyRendererSourceMutations({
  name: 'browser-operation-state-density-mutations',
  tests: ['apps/desktop/test/browser-operation-state-density.test.tsx'],
  sources: [component, pane, 'apps/desktop/src/renderer/src/styles/browser-operation-surface.css'],
  mutations: [
    { label: 'state-glyphs-collapse', file: component, before: '<PhaseGlyph phase={phase} />', after: '<PhaseGlyph phase="completed" />' },
    { label: 'stop-action-disconnected', file: component, before: 'onSelect={() => onStop()}', after: 'onSelect={() => {}}' },
    { label: 'separate-operation-toolbar', file: pane, before: status, after: `      </form>\n${status}\n      <form className="browser-operation-toolbar">` }
  ]
})
