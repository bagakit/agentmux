import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import { renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
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
const calls: Array<{ reference: { hostId: string; agentSessionId: string }; messageId: string }> = []
const pending: Array<{ resolve(value: { hostId: string; message: DurableAgentMuxMessage | null }): void; reject(error: Error): void }> = []
api.sessions.readMessage = (reference, id) => {
  calls.push({ reference: { ...reference }, messageId: id })
  return new Promise((resolve, reject) => pending.push({ resolve, reject }))
}
mountThemeRuntime(window, { appAppearance: 'dark' })
let reset: (generation: number) => void
function Scene() {
  const [generation, setGeneration] = useState(0)
  reset = setGeneration
  return <DesktopClientUiProvider>
    <main className="original-reading-probe" data-generation={generation}>
      <header className="original-reading-probe__header"><strong>Conversation</strong><span>A2A original reading</span></header>
      <section className="original-reading-probe__messages" aria-label="Conversation records" key={generation}>
        <ConversationMessage messageId="probe-notice-record" speaker={{ role: 'system' }} recordTitle="A2A 通知"
          a2aNotificationId="notice-original" executionHostId={hostId} conversationSessionId={recipientSessionId} content={wire} />
        <ConversationMessage messageId="probe-unqualified-record" speaker={{ role: 'system' }} recordTitle="普通记录中的引用"
          executionHostId={hostId} conversationSessionId={recipientSessionId} content={wire} />
      </section>
      <label className="original-reading-probe__draft">Draft<textarea aria-label="Unsent draft" defaultValue={draft} /></label>
    </main>
  </DesktopClientUiProvider>
}
Object.assign(window, { a2aOriginalReading: {
  ready: true,
  seed(theme: 'dark' | 'light', generation: number) {
    if (pending.length) throw new Error('Do not discard an unsettled private original read')
    calls.length = 0
    updateThemeSelection({ appAppearance: theme })
    flushSync(() => reset(generation))
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent draft"]')!
    field.value = draft
    return { hostId, recipientSessionId, senderSessionId, messageId, body, wire, draft }
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
