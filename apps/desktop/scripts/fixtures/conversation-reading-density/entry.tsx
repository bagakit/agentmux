import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { DensityDesktop } from './desktop'
import { api } from '../../../src/renderer/src/lib/api'
import { MobileConversationSurface } from '../../../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../../../mobile/src/platform/browser'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ConversationObservation } from '@agentmux/core/conversation'
import '../../../src/renderer/src/styles/index.css'
import '../../../../mobile/src/conversation/conversation.css'
import './preview.css'

mountThemeRuntime(window, { appAppearance: 'dark' })
const data = await (await fetch('./reading.json')).json()
const copies: string[] = [], controls: string[] = [], reads: string[] = []
const watchers = new Set<(observation: ConversationObservation) => void>()
let updated = false
const reader = {
  readAgentConversation: async () => { reads.push('readAgentConversation'); return updated ? data.changes : data.frame },
  readConversationChanges: async () => { reads.push('readConversationChanges'); return updated ? data.changes : data.frame },
  observeConversation: async (_input: unknown, listener: (observation: ConversationObservation) => void) => {
    const closed = new AbortController(); watchers.add(listener)
    return { sourceHostId: data.frame.sourceHostId, scope: data.frame.scope, closed: closed.signal,
      dispose() { watchers.delete(listener); closed.abort() } }
  }, releaseConversationView: async () => {}
}
Object.assign(api.conversation, reader)
api.ui.writeClipboardText = async text => { copies.push(text) }
const prohibit = async () => { controls.push('input'); throw Error('Read-only private qualification cannot control a Run') }
const client = { ...reader, agentSession: () => data.session, agentSessions: () => [data.session], runtimeOwnerIdentity: () => null,
  statusAgent: async () => { throw Error('The sample has no active Run') }, onEvent: () => () => {},
  submitAgentPrompt: prohibit, submitAgentMessage: prohibit, respondAgentInteraction: prohibit, catalog: () => [] } as unknown as AgentMuxHostedClient
const mobilePlatform = { ...createBrowserPlatform(), copyText: async (text: string) => { copies.push(text); return true } }
function Scene() {
  const [mode, setMode] = useState('desktop'), [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState(data.expected.draft)
  Object.assign(window, { readingDensityPreview: { copies, controls, reads, data, mode: setMode,
    appearance: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
    unrelated: () => setRevision(value => value + 1),
    append: () => { updated = true; for (const listener of watchers) listener({ ...data.frame.scope, hostId: 'local', agentSessionId: data.expected.sessionId,
      sourceHostId: data.frame.sourceHostId, source: data.frame.scope.sources.find((source: { kind: string }) => source.kind === 'native'), kind: 'invalidated' }) }
  } })
  return <main className="reading-density-preview" data-scene={mode} data-revision={revision}>
    <header><strong>Conversation</strong><span>原记录与来源贡献</span></header>
    <div className="reading-density-preview__reading">
      {mode === 'mobile' ? <MobileConversationSurface client={client} agentSessionId={data.expected.sessionId} displayName="Conversation review"
        connection={{ state: 'connected', message: 'Private original reading sample' }} platform={mobilePlatform} />
        : <DensityDesktop data={data} reader={reader} platform={mobilePlatform} />}
    </div>
    {mode === 'desktop' ? <footer><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /></footer> : null}
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
