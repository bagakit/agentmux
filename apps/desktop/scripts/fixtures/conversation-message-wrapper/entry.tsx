import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { MobileConversationSurface } from '../../../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../../../mobile/src/platform/browser'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AgentSessionHistoryResourceRequest } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import '../../../src/renderer/src/styles/index.css'
import '../../../../mobile/src/conversation/conversation.css'
import './preview.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const data = await (await fetch('./reading.json')).json()
const copies: string[] = [], controls: string[] = [], reads: string[] = []
const observation = () => {
  const closed = new AbortController()
  return Promise.resolve({ sourceHostId: data.frame.sourceHostId, scope: data.frame.scope, closed: closed.signal, dispose() { closed.abort() } })
}
const reader = {
  readAgentConversation: async () => { reads.push('readAgentConversation'); return data.frame },
  readConversationChanges: async () => data.changes,
  observeConversation: observation, releaseConversationView: async () => {}
}
Object.assign(api.conversation, reader)
api.ui.writeClipboardText = async text => { copies.push(text) }
const readResource = async (input: AgentSessionHistoryResourceRequest) => {
  reads.push('resource:' + input.partIndex)
  if (input.recordId !== data.resource.recordId || input.expectedReference !== data.resource.reference) throw Error('Wrong original resource')
  return { agentSessionId: 'reader', source: data.resource.source, recordId: data.resource.recordId, partIndex: input.partIndex, reference: data.resource.reference,
    result: { status: 'fragment' as const, encoding: 'json-utf8' as const, dataBase64: data.resource.bytesBase64, offsetBytes: 0,
      byteLength: data.resource.byteLength, totalBytes: data.resource.byteLength, sha256: data.resource.sha256, nextOffsetBytes: null } }
}
const prohibit = async () => { controls.push('input'); throw Error('This read-only scene cannot control a Run') }
const client = { ...reader, agentSession: () => data.session, agentSessions: () => [data.session], runtimeOwnerIdentity: () => null,
  statusAgent: async () => { throw Error('The read-only sample has no active Run') }, onEvent: () => () => {},
  sessionHistoryResource: async (_id: string, input: AgentSessionHistoryResourceRequest) => readResource(input),
  submitAgentPrompt: prohibit, submitAgentMessage: prohibit, respondAgentInteraction: prohibit, catalog: () => [] } as unknown as AgentMuxHostedClient
const mobilePlatform = { ...createBrowserPlatform(), copyText: async (text: string) => { copies.push(text); return true } }
function Scene() {
  const [mode, setMode] = useState('desktop'), [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState('Keep the original reply draft.')
  Object.assign(window, { messageWrapperPreview: { copies, controls, reads, data, mode: setMode, appearance: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }), update: () => setFailed(value => !value) } })
  return <main className="message-wrapper-preview" data-scene={mode}>
    <header><strong>Conversation</strong><span>Read-only protocol sample</span></header>
    <div className="message-wrapper-preview__reading">
      {mode === 'mobile' ? <MobileConversationSurface client={client} agentSessionId="reader" connection={{ state: 'connected', message: 'Private Core reading sample' }} platform={mobilePlatform} />
        : <DesktopClientUiProvider><ActivityView sessionId="reader" executionHostId="local" items={[]} capability="complete-events"
          conversationReading={{ reference: { hostId: 'local', agentSessionId: 'reader' }, identity: 'original-reading', enabled: true, opened: true }} />
          <section className="message-wrapper-preview__resource"><h2>Complete original resource</h2>
            <ConversationMessage messageId={data.resource.recordId} conversationSessionId="reader" content={[data.resource.part]}
              speaker={{ role: 'agent', id: 'reviewer' }} name="Recorded review Agent" status={failed ? 'failed' : 'complete'}
              readHistoryResource={readResource} nativeResourceRecord={{ source: data.resource.source, recordId: data.resource.recordId }} />
          </section></DesktopClientUiProvider>}
    </div>
    {mode === 'desktop' ? <footer><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /></footer> : null}
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
