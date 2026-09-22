import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const dock = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
const css = 'apps/desktop/src/renderer/src/styles/browser.css'
await verifyRendererSourceMutations({
  name: `browser-tools-density-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/browser-tools-density.test.tsx'],
  sources: [dock, css, 'apps/desktop/src/renderer/src/components/BrowserProfilesPanel.tsx',
    'apps/desktop/src/renderer/src/components/settings/SettingsSaveBar.tsx',
    'apps/desktop/src/renderer/src/components/settings/use-setting-draft.ts'],
  mutations: [
    { label: 'create-disconnected', file: dock,
      before: 'onClick={() => void openBrowser()}', after: 'onClick={() => {}}' },
    { label: 'save-disconnected', file: dock,
      before: 'saveState.run(() => onSave(submitted.value, submitted.expected))',
      after: 'saveState.run(() => Promise.resolve())' },
    { label: 'annotation-consumer-disconnected', file: dock,
      before: 'appendAgentComposerDraft(sessionId, formatBrowserAnnotationsContext(currentAnnotations))',
      after: 'void sessionId' },
    { label: 'standing-introduction', file: dock,
      before: '<section className="browser-tools-panel" aria-label="Browser Tools">',
      after: '<section className="browser-tools-panel" aria-label="Browser Tools"><h2>Open a browser tab</h2>' },
    { label: 'nested-profile-card', file: css,
      before: '.browser-profiles { width: 100%; display: grid; gap:var(--sp-3); }',
      after: '.browser-profiles { width: 100%; display: grid; gap:var(--sp-3); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-1); }' },
    { label: 'save-failure-hidden', file: dock,
      before: '{saveState.error ? <p className="settings-inline-error" role="alert">{saveState.error}</p> : null}',
      after: '{saveState.error ? null : null}' },
    { label: 'preferences-always-open', file: dock,
      before: '<details>', after: '<details open>' }
  ]
})
