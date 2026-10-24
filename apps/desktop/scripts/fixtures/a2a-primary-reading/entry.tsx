import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { FocusMessagePreview } from '../../../src/renderer/src/components/FocusMessagePreview'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { MobileConversationSurface } from '../../../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../../../mobile/src/platform/browser'
import { api } from '../../../src/renderer/src/lib/api'
import inputScene from 'virtual:a2a-primary-scene'
import '../../../src/renderer/src/styles/index.css'
import './surface.css'

let scene = inputScene.scenarios?.idle ?? inputScene
const calls: Array<{ reference: unknown; messageId: string; notificationId?: string }> = []
const pending: Array<{ messageId: string; resolve(value: unknown): void; reject(error: Error): void }> = []
const copied: string[] = []
const draft = '保留这份尚未发送的草稿。'
const read = async (reference: unknown, messageId: string, notificationId?: string) => {
  calls.push({ reference, messageId, notificationId })
  return new Promise((resolve, reject) => pending.push({ messageId, resolve, reject }))
}
api.ui.writeClipboardText = async text => { copied.push(text) }
api.sessions.readMessage = async (reference, messageId, notificationId) => ({ hostId: reference.hostId, message: await read(reference, messageId, notificationId) as typeof scene.original })
const reader = {
  readAgentConversation: async () => structuredClone(scene.page),
  readConversationChanges: async () => structuredClone(scene.page),
  observeConversation: async () => ({ sourceHostId: scene.snapshot.sourceHostId, scope: scene.snapshot.scope, closed: new AbortController().signal, dispose() {} }),
  releaseConversationView: async () => ({})
}
Object.assign(api.conversation, reader)
const mobileClient = {
  ...reader, agentSession: () => scene.session, agentSessions: () => [scene.session], runtimeOwnerIdentity: () => null,
  catalog: () => [], onEvent: () => () => {}, statusAgent: async () => { throw Error('No Runtime in the private reading scene') },
  readMessage: ({ messageId, notificationId }: { messageId: string; notificationId?: string }) => read(scene.reference, messageId, notificationId)
} as unknown as AgentMuxHostedClient
const platform = createBrowserPlatform({ clipboard: { writeText: async text => { copied.push(text) } } })
const root = createRoot(document.getElementById('root')!)
mountThemeRuntime(window, { appAppearance: 'dark' })
function Scene({ surface, generation }: { surface: 'desktop' | 'mobile' | 'focus'; generation: number }) {
  const label = surface === 'desktop' ? 'Desktop Conversation' : surface === 'mobile' ? 'Mobile Conversation' : 'Focus Preview'
  return <DesktopClientUiProvider><main className="primary-reading-probe" data-generation={generation} data-surface={surface}>
    <header className="primary-reading-probe__header"><strong>{label}</strong><span>A2A 原信</span></header>
    <section className="primary-reading-probe__reader">
      {surface === 'desktop' ? <ActivityView sessionId={scene.reference.agentSessionId} executionHostId={scene.reference.hostId} capability="complete-events"
        conversationReading={{ reference: scene.reference, identity: 'original-reader', enabled: true, opened: true }} /> : null}
      {surface === 'mobile' ? <MobileConversationSurface client={mobileClient} agentSessionId={scene.reference.agentSessionId}
        connection={{ state: 'connected', message: 'Private original Host' }} platform={platform} /> : null}
      {surface === 'focus' ? <FocusMessagePreview message={scene.projection.records[0]} sender={undefined} recipient={undefined} lane={undefined} hierarchy={undefined}
        interactive autoFocus={false} anchor={document.querySelector<HTMLButtonElement>('#focus-anchor')!} describeSpeaker={speaker => ({ name: speaker.id })}
        onSelect={() => {}} onClose={() => {}} /> : null}
    </section>
    <label className="primary-reading-probe__draft">Draft<textarea aria-label="Unsent draft" defaultValue={draft} /></label>
  </main></DesktopClientUiProvider>
}
const anchorHost = document.createElement('section'); anchorHost.className = 'recent-focus primary-reading-probe__focus-anchor'
anchorHost.style.width = 'calc(100vw - 32px)'; anchorHost.style.bottom = '200px'
anchorHost.innerHTML = '<header class="recent-focus__header"><span>原协作记录</span></header><button id="focus-anchor" class="recent-focus__message" aria-label="原协作记录" style="left:50%;width:16px;height:16px"></button>'
document.body.append(anchorHost)
Object.assign(window, { a2aPrimaryReading: {
  ready: true,
  seed(surface: 'desktop' | 'mobile' | 'focus', theme: 'dark' | 'light', generation: number, variant = 'idle') {
    if (pending.length) throw Error('Do not discard an unsettled private original read')
    scene = inputScene.scenarios?.[variant] ?? inputScene
    calls.length = 0; copied.length = 0; updateThemeSelection({ appAppearance: theme })
    anchorHost.hidden = surface !== 'focus'
    // Product chrome explicitly sets display:flex; the private anchor must not cover another reader's input.
    anchorHost.style.display = surface === 'focus' ? 'flex' : 'none'
    flushSync(() => root.render(<Scene key={generation} surface={surface} generation={generation} />))
    return { messageId: scene.messageId, notificationId: scene.notificationId, messages: scene.originals.map(({ envelope }) => ({ messageId: envelope.messageId, senderSessionId: envelope.senderSessionId, body: envelope.body })), body: scene.body, wire: scene.wire, draft, reference: scene.reference }
  },
  settle(outcome: 'failure' | 'original') {
    const request = pending.shift(); if (!request) throw Error('The private original read is not pending')
    if (outcome === 'failure') request.reject(Error('原信存储暂不可用，原引用保留。'))
    else request.resolve(structuredClone(scene.originals.find(({ envelope }) => envelope.messageId === request.messageId)))
  },
  facts() { return { calls: structuredClone(calls), copied: [...copied], pending: pending.length,
    draft: document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent draft"]')?.value,
    draftFocused: document.activeElement === document.querySelector('[aria-label="Unsent draft"]') } }
} })
