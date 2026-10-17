import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { MobileConversationSurface } from '../../../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../../../mobile/src/platform/browser'
import '../../../src/renderer/src/styles/index.css'
import '../../../../mobile/src/conversation/conversation.css'
import '../conversation-message-wrapper/preview.css'
import './preview.css'

const data = await (await fetch('./reading.json')).json()
const copies: string[] = [], controls: string[] = [], reads: string[] = []
let selected = 'markers'
const current = () => data.groups[selected]
const reader = {
  readAgentConversation: async () => { reads.push(selected); return current().frame },
  readConversationChanges: async () => current().changes,
  observeConversation: async () => { const closed = new AbortController(); return {
    sourceHostId: current().frame.sourceHostId, scope: current().frame.scope,
    closed: closed.signal, dispose() { closed.abort() }
  } },
  releaseConversationView: async () => {}
}
Object.assign(api.conversation, reader)
api.ui.writeClipboardText = async text => { copies.push(text) }
const prohibit = async () => { controls.push('input'); throw Error('This read-only source preview cannot control a Run') }
api.sessions.submitPrompt = prohibit
const config = await api.config.get()
useAppStore.setState({ config, sessions: [], loading: false, mainSurface: 'workbench' })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
const client = { ...reader, agentSession: () => current().session, agentSessions: () => [current().session], runtimeOwnerIdentity: () => null,
  statusAgent: async () => { throw Error('This read-only original has no active Run') }, onEvent: () => () => {},
  submitAgentPrompt: prohibit, submitAgentMessage: prohibit, respondAgentInteraction: prohibit, catalog: () => [] } as unknown as AgentMuxHostedClient
const platform = { ...createBrowserPlatform(), copyText: async (text: string) => { copies.push(text); return true } }

function Scene() {
  const [mode, setMode] = useState('settings'), [group, setGroup] = useState('markers'), [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState('Keep the original reply draft.')
  Object.assign(window, { protocolCapture: { data, copies, controls, reads, ready: true,
    mode: setMode, group: (next: string) => { selected = next; setGroup(next) }, update: () => setRevision(value => value + 1),
    appearance: (appAppearance: 'light' | 'dark') => updateThemeSelection({ ...config.appearance, appAppearance }) } })
  return <main className="message-wrapper-preview protocol-capture" data-scene={mode} data-revision={revision}>
    <header><strong>amux protocols</strong><span>Current source · read-only examples</span></header>
    <div className="message-wrapper-preview__reading">
      {mode === 'settings' ? <DesktopClientUiProvider><SettingsPanel initialSection="amux-protocols" onClose={() => {}} /></DesktopClientUiProvider>
        : mode === 'mobile' ? <MobileConversationSurface key={group} client={client} agentSessionId="reader"
          connection={{ state: 'connected', message: 'Private source reading sample' }} platform={platform} />
          : <DesktopClientUiProvider><ActivityView key={group} sessionId="reader" executionHostId="local" items={[]} capability="complete-events"
            conversationReading={{ reference: { hostId: 'local', agentSessionId: 'reader' }, identity: `capture:${group}`, enabled: true, opened: true }} /></DesktopClientUiProvider>}
    </div>
    {mode === 'desktop' ? <footer><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /></footer> : null}
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
