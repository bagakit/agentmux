import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import { renderAgentMuxMessageEnvelope, renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { composeAgentPrompt, formatAmuxTriggerNote } from '@agentmux/core/agent-outbound-message'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { CapturedConversationMessage } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import './surface.css'

const hostId = 'probe-host', recipientSessionId = 'probe-recipient', senderSessionId = 'probe-sender', messageId = 'probe-mid'
const wire = renderAgentMuxMessageReferences([{ senderSessionId, messageId }])
const draft = '保留这份尚未发送的草稿。'
const body = [
  '### 原始协作消息',
  '请核对 **消息原文与接收者**，然后保留当前草稿。',
  '- 接收 Session：`probe-recipient`\n- 原始 Host：`probe-host`',
  '长引用：`MID-original-body-0123456789abcdefghijklmnopqrstuvwxyz-0123456789abcdefghijklmnopqrstuvwxyz-0123456789abcdefghijklmnopqrstuvwxyz`',
  '> 这里只读取原文；显示成功不会表示任务已接受。',
  '原文结束：中文、Markdown 与长引用均保留。'
].join('\n\n')
const original: DurableAgentMuxMessage = {
  sequence: 1,
  envelope: {
    schema: 'agentmux.a2a.v1', messageId, operationId: 'probe-original-operation', createdAt: _privacyFixtureEpoch(20749, 11400),
    sender: { kind: 'agent-session', agentSessionId: senderSessionId }, recipient: { kind: 'agent-session', agentSessionId: recipientSessionId },
    threadId: 'probe-thread', correlationId: 'probe-correlation', replyTo: null, workspaceId: null,
    senderSessionId, senderRunId: 'probe-sender-run', recipientSessionId, recipientRunId: 'probe-recipient-run', body
  },
  delivery: { state: 'queued', at: _privacyFixtureEpoch(20749, 11400) }, deliveryMode: 'reference'
}
const protocolCards = new URLSearchParams(location.search).get('protocolCards') === '1'
const bodies = { a2a: '原审阅已经完成，两个决定等待你的确认。', heartbeat: '继续核对上次尚未解决的问题。', calendar: '检查设计稿，并记录这次决定。', automation: '继续已确认的下一步，整理待办。' }
const declared = {
  a2a: renderAgentMuxMessageEnvelope({ ...original.envelope, body: bodies.a2a }),
  ...Object.fromEntries((['heartbeat','calendar','automation'] as const).map(kind=>[kind,composeAgentPrompt(bodies[kind],formatAmuxTriggerNote(kind,'仅在原授权范围内继续。')).text]))
}
const calls: Array<{ reference: { hostId: string; agentSessionId: string }; messageId: string }> = []
const pending: Array<{ resolve(value: { hostId: string; message: DurableAgentMuxMessage | null }): void; reject(error: Error): void }> = []
api.sessions.readMessage = (reference, id) => {
  calls.push({ reference: { ...reference }, messageId: id })
  return new Promise((resolve, reject) => pending.push({ resolve, reject }))
}
mountThemeRuntime(window, { appAppearance: 'dark' })
let reset: (generation: number) => void
let showDeclarations = protocolCards
let showCaptured = false
function Scene() {
  const [generation, setGeneration] = useState(0)
  reset = setGeneration
  return <DesktopClientUiProvider>
    <main className="original-reading-probe" data-generation={generation}>
      <header className="original-reading-probe__header"><strong>Conversation</strong><span>A2A original reading</span></header>
      <section className="original-reading-probe__messages" aria-label="Conversation records" key={generation}>
        {generation === 0 ? null : showCaptured ? (['heartbeat','calendar','automation'] as const).map(kind=><CapturedConversationMessage key={kind}
          item={{id:'captured-'+kind,agentSessionId:recipientSessionId,source:'user',kind:'user_message',title:'Prompt',status:'complete',createdAt:0,updatedAt:0,content:bodies[kind],publicContent:'confirmed',declaredTrigger:kind}}
          recordedIdentity speaker={{role:'unknown'}} conversationSessionId={recipientSessionId} executionHostId={hostId} />)
        : showDeclarations ? Object.entries(declared).map(([kind, content])=><ConversationMessage key={kind} messageId={'declared-'+kind}
          recordedIdentity speaker={kind==='a2a' ? {role:'agent',id:senderSessionId} : {role:'unknown'}} executionHostId={hostId} conversationSessionId={recipientSessionId} content={content} />) : <ConversationMessage messageId="probe-notice-record" speaker={{ role: 'system' }} recordTitle="A2A 通知"
          a2aNotificationId="notice-original" itemRef={{hostId,agentSessionId:recipientSessionId,source:{kind:'captured',recordId:'notice-original'}}} executionHostId={hostId} conversationSessionId={recipientSessionId} content={wire} />
        }
        {protocolCards ? null : <ConversationMessage messageId="probe-unqualified-record" speaker={{ role: 'system' }} recordTitle="普通记录中的引用"
          executionHostId={hostId} conversationSessionId={recipientSessionId} content={wire} />}
      </section>
      <label className="original-reading-probe__draft">Draft<textarea aria-label="Unsent draft" defaultValue={draft} /></label>
    </main>
  </DesktopClientUiProvider>
}
Object.assign(window, { a2aOriginalReading: {
  ready: true,
  seed(theme: 'dark' | 'light', generation: number, face?: 'declarations' | 'original' | 'captured') {
    if (pending.length) throw new Error('Do not discard an unsettled private original read')
    calls.length = 0
    showDeclarations = protocolCards && face === 'declarations'
    showCaptured = protocolCards && face === 'captured'
    updateThemeSelection({ appAppearance: theme })
    flushSync(() => reset(generation))
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent draft"]')!
    field.value = draft
    return { hostId, recipientSessionId, senderSessionId, messageId, body, wire, draft, declared, bodies }
  },
  settle(outcome: 'failure' | 'original') {
    const request = pending.shift()
    if (!request) throw new Error('The private scene has no original read to settle')
    if (outcome === 'failure') request.reject(new Error('Original message storage is temporarily unavailable. The reference is retained.'))
    else request.resolve({ hostId, message: structuredClone(original) })
  },
  facts() { return { calls: structuredClone(calls), pending: pending.length, draft: document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent draft"]')?.value,
    draftFocused: document.activeElement === document.querySelector('[aria-label="Unsent draft"]') } }
} })
createRoot(document.getElementById('root')!).render(<Scene />)
