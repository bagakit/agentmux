import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { loader } from '@monaco-editor/react'
import type { AppConfig } from '../../../src/shared/contracts'
import type { ToolkitToolDefinition, ToolkitScriptSnapshot } from '@agentmux/core/control'
import { ToolkitSettingsPane } from '../../../src/renderer/src/components/settings/ToolkitSettingsPane'
import { UserToolkitResult } from '../../../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import '../../../src/renderer/src/monaco'
import '../../../src/renderer/src/styles/index.css'

// This fixture owns only configuration IPC. Result DTOs are deliberately synthetic.
const w = window as any, bridge = w.identityProof
let current: AppConfig = await bridge.get()
const events: { type: string; trusted: boolean; target: string; key?: string; meta?: boolean; control?: boolean }[] = []
for (const type of ['click', 'input', 'keydown']) document.addEventListener(type, event => {
  const node = event.target as HTMLElement
  events.push({ type, trusted: event.isTrusted, target: node?.getAttribute('aria-label') ?? node?.className ?? '', ...(event instanceof KeyboardEvent ? { key: event.key, meta: event.metaKey, control: event.ctrlKey } : {}) })
}, true)
const resultReads: string[] = [], executionCalls: string[] = [], configureTargets: string[] = []
let result: ToolkitScriptSnapshot | null = null, readers = 0
let disposeAppearance = applyAppAppearance('dark')
api.toolkit = {
  ...api.toolkit,
  async get(id) { resultReads.push(id); if (!result || result.toolId !== id) throw Error('No controlled DTO for this exact tool'); return result },
  observe(id, read) { resultReads.push(id); if (!result || result.toolId !== id) throw Error('No controlled DTO for this exact tool'); readers++; read(result); return { dispose() { readers-- } } },
  async run() { executionCalls.push('run'); throw Error('This identity fixture never runs scripts') },
  async action() { executionCalls.push('action'); throw Error('This identity fixture never runs actions') },
  async stop() { executionCalls.push('stop'); throw Error('This identity fixture never controls Run lifecycle') }
}
let showResult!: (tool: ToolkitToolDefinition | null) => void, setTheme!: (theme: 'light' | 'dark') => void
let navigate!: (id: string | undefined) => void, setActive!: (active: boolean) => void
function App() {
  const [config, setConfig] = useState(current), [tool, setTool] = useState<ToolkitToolDefinition | null>(null)
  const [active, activeState] = useState(true), [target, setTarget] = useState<string | undefined>(), [request, setRequest] = useState(0)
  showResult = setTool; setActive = activeState
  setTheme = value => { disposeAppearance(); disposeAppearance = applyAppAppearance(value); useAppStore.setState({ config: { ...current, appearance: { ...current.appearance, appAppearance: value } } }) }
  navigate = id => { setTarget(id); setRequest(value => value + 1) }
  w.identityPublish = (next: AppConfig) => { current = next; setConfig(next) }
  return <SettingsNavigation.Provider value={{ open() {}, openToolkit(id) { configureTargets.push(id); setTool(null); navigate(id); activeState(true) } }}>
    <div data-identity-viewport style={{ height: '100vh', overflow: 'auto', background: 'var(--surface-0)', color: 'var(--text)' }}>
      {tool ? <section className="performance-popover" style={{ position: 'relative', width: 'min(480px, calc(100% - 24px))', margin: '36px auto' }}><UserToolkitResult definition={tool} active close={() => setTool(null)} /></section> : <main data-settings-page="toolkit" className="settings-content" style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
        <header className="settings-content__header"><div className="settings-content__title"><div><div className="settings-content__breadcrumb"><span>Preferences</span></div><h2>Toolkit</h2><p>Local tools and results, right where you work.</p></div></div></header>
        <div className="settings-content__scroll" data-settings-pane="toolkit" style={{ overflow: 'visible' }}>
          <ToolkitSettingsPane performance={config.toolkit?.performance ?? { enabled: true, statusBar: 'icon' }} tools={config.toolkit?.tools ?? []} toolId={target}
            navigationRequest={{ section: 'toolkit', toolId: target, executorId: String(request) }} active={active}
            writer={{ add: bridge.add, update: bridge.update }} onRemoveTool={bridge.remove} onSave={bridge.savePerformance}
            onRunTool={async () => { executionCalls.push('editor-run'); throw Error('Identity proof never executes scripts') }} />
        </div>
      </main>}
    </div>
  </SettingsNavigation.Provider>
}
bridge.onChange((next: AppConfig) => w.identityPublish(next))
useAppStore.setState({ config: { ...current, appearance: { ...current.appearance, appAppearance: 'dark' } } })
createRoot(document.getElementById('root')!).render(<App />)
w.identityScene = {
  ready: true, events, executionCalls, resultReads, configureTargets,
  configuration: () => current, navigate: (id: string | undefined) => navigate(id), theme: (theme: 'light' | 'dark') => setTheme(theme), active: (value: boolean) => setActive(value),
  models: async () => (await loader.init()).editor.getModels().map(model => ({ uri: model.uri.toString(), value: model.getValue() })),
  scriptValue: async () => { const models = (await loader.init()).editor.getModels(); if (models.length !== 1) throw Error('Expected one actual selected model'); return models[0]!.getValue() },
  scriptFocused: async () => { const monaco = await loader.init(), models = monaco.editor.getModels(); return models.length === 1 && monaco.editor.getEditors().filter(editor => editor.hasTextFocus() && editor.getModel() === models[0]).length === 1 },
  result: (definition: ToolkitToolDefinition) => {
    result = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'succeeded', reason: null, admission: null, consumerCount: 1, sequence: 1,
      latestConfirmed: { executionId: 'synthetic-identity-only', invocationId: 'synthetic-identity-only', definition, expectedLatestExecutionId: null,
        target: { workspacePath: definition.workspacePath }, run: { hostId: 'synthetic', runId: 'not-a-real-run' }, startedAt: 1, endedAt: 2, exitCode: 0, state: 'succeeded', reason: null, text: 'Workspace summary\n8 files checked · 2 notes ready\nControlled presentation fixture; no script was executed.' } }
    showResult(definition)
  }, readers: () => readers
}
