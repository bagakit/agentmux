import { createRoot } from 'react-dom/client'
import { unwrapSessionObservationResult } from '../../../src/shared/session-observation-result'
import { unwrapSessionInputWriteResult } from '../../../src/shared/session-input-result'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { createToolkitConfigurationApi } from '../../../src/renderer/src/lib/toolkit-configuration-api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { useAppStore } from '../../../src/renderer/src/store'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import '../../../src/renderer/src/styles/index.css'

const w = window as any, bridge = w.tuiProof
const setup = await bridge.seed(await api.config.get())
api.config.get = () => bridge.get()
api.config.save = (next, expected) => bridge.save(next, expected)
api.config.onChange = listener => bridge.onChange(listener)
api.toolkit = createToolkitConfigurationApi(w.agentmux.toolkit)
const transport = w.agentmux.sessions
api.sessions = { ...transport, onEvent: createRendererSessionEvents(transport.onEvent),
  attach: (...args) => transport.attach(...args).then(unwrapSessionObservationResult),
  refreshAttachment: (...args) => transport.refreshAttachment(...args).then(unwrapSessionObservationResult),
  replay: (...args) => transport.replay(...args).then(unwrapSessionObservationResult),
  write: (...args) => transport.write(...args).then((result: any) => { unwrapSessionInputWriteResult(result) }),
  paste: (...args) => transport.paste(...args).then((result: any) => { unwrapSessionInputWriteResult(result) }) }

const attachments: unknown[] = [], writes: unknown[] = [], keys: unknown[] = []
const attach = api.sessions.attach, write = api.sessions.write
api.sessions.attach = async (...args) => { const result = await attach(...args); attachments.push({ control: args[0], attachmentId: result.attachmentId, session: result.session }); return result }
api.sessions.write = async (...args) => { await write(...args); writes.push({ control: args[0], data: args[1], source: args[2] }) }
document.addEventListener('keydown', event => keys.push({ key: event.key, trusted: event.isTrusted, terminal: Boolean((event.target as HTMLElement)?.closest('.xterm')) }), true)
useLauncherState.getState().setSection(setup.workspaceId, 'terminal', 'collapsed')
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
while (useAppStore.getState().loading || !useAppStore.getState().config) await new Promise(resolve => setTimeout(resolve, 10))
useAppStore.setState({ activeWorkspaceId: setup.workspaceId, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false })
w.tuiScene = { ready: true, attachments, writes, keys, setup,
  config: () => useAppStore.getState().config,
  toolkit: async (id: string) => api.toolkit.get(id),
  editor: async () => {
    const { editor } = await import('monaco-editor')
    const mounted = editor.getEditors().find(item => item.getDomNode()?.isConnected), model = mounted?.getModel(), selection = mounted?.getSelection()
    return model ? { language: model.getLanguageId(), value: model.getValue(), model: model.id, selectedAll: selection?.equalsRange(model.getFullModelRange()),
      tokens: editor.tokenize(model.getValue(), model.getLanguageId()),
      painted: [...document.querySelectorAll('.monaco-editor .view-line span[class*="mtk"]')].map(node => ({ text: node.textContent, color: getComputedStyle(node).color })) } : null
  } }
