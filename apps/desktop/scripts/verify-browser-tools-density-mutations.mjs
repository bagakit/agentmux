import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const tools = 'apps/desktop/src/renderer/src/components/SearchBrowserTools.tsx'
const preferences = 'apps/desktop/src/renderer/src/components/BrowserToolbarPreferences.tsx'
const annotations = 'apps/desktop/src/renderer/src/components/BrowserAnnotationsPanel.tsx'
const search = 'apps/desktop/src/renderer/src/components/GlobalSearchSurface.tsx'
const app = 'apps/desktop/src/renderer/src/App.tsx'
const store = 'apps/desktop/src/renderer/src/store.ts'
const css = 'apps/desktop/src/renderer/src/styles/browser.css'
await verifyRendererSourceMutations({
  name: `browser-tools-density-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/browser-tools-density.test.tsx', 'apps/desktop/test/search-surface.test.tsx'],
  sources: [search, tools, preferences, annotations, app, store, css, 'apps/desktop/src/renderer/src/components/BrowserProfilesPanel.tsx',
    'apps/desktop/src/renderer/src/components/settings/SettingsSaveBar.tsx',
    'apps/desktop/src/renderer/src/components/settings/use-setting-draft.ts'],
  mutations: [
    { label: 'create-disconnected', file: search,
      before: 'await createBrowser(layout.activeGroupId, undefined, input)', after: 'await Promise.resolve()' },
    { label: 'query-disconnected', file: search,
      before: 'if (query.trim()) void openBrowser(query)', after: "if (query.trim()) void openBrowser('about:blank')" },
    { label: 'search-app-consumer-disconnected', file: app,
      before: "<GlobalSearchSurface visible={mainSurface === 'search' && !settingsRoute} />", after: 'null' },
    { label: 'visited-search-drafts-unmounted', file: app,
      before: "{searchVisited || mainSurface === 'search' ?", after: "{mainSurface === 'search' ?" },
    { label: 'hidden-search-tools-subscribe', file: tools,
      before: 'subscribe: visible ? useAppStore.subscribe : () => () => {}', after: 'subscribe: useAppStore.subscribe' },
    { label: 'selected-agent-replaces-new-browser', file: search,
      before: 'await selectWorkspace(workspace.id)', after: "useAppStore.getState().setMainSurface('workbench')" },
    { label: 'search-restore-disconnected', file: store,
      before: "if (candidate === 'search') return 'search'", after: "if (candidate === 'search') return 'workbench'" },
    { label: 'annotation-collection-empty', file: tools,
      before: 'const browserAnnotations = useMemo(() => Object.values(browserAnnotationsByBrowserId).flat()\n    .filter((annotation) => annotation.workspaceId === workspace.id), [browserAnnotationsByBrowserId, workspace.id])',
      after: 'const browserAnnotations = []' },
    { label: 'save-disconnected', file: preferences,
      before: 'saveState.run(() => onSave(submitted.value, submitted.expected))',
      after: 'saveState.run(() => Promise.resolve())' },
    { label: 'annotation-consumer-disconnected', file: tools,
      before: 'appendAgentComposerDraft(sessionId, formatBrowserAnnotationsContext(currentAnnotations))',
      after: 'void sessionId' },
    { label: 'standing-introduction', file: tools,
      before: '<section className="browser-tools-panel" aria-label="Browser Tools">',
      after: '<section className="browser-tools-panel" aria-label="Browser Tools"><h2>Open a browser tab</h2>' },
    { label: 'nested-profile-card', file: css,
      before: '.browser-profiles { width: 100%; display: grid; gap:var(--sp-3); }',
      after: '.browser-profiles { width: 100%; display: grid; gap:var(--sp-3); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-1); }' },
    { label: 'save-failure-hidden', file: preferences,
      before: '{saveState.error ? <p className="settings-inline-error" role="alert">{saveState.error}</p> : null}',
      after: '{saveState.error ? null : null}' },
    { label: 'preferences-always-open', file: preferences,
      before: '<details>', after: '<details open>' }
  ]
})
