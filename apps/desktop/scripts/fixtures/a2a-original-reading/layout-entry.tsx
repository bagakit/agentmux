import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import { renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import './surface.css'

const hostId = 'layout-host', recipientSessionId = 'layout-recipient', senderSessionId = 'layout-sender', messageId = 'layout-original'
const body = '修复 Browser 内发光 Agent 消息宽度。原始中文、LongReferenceToken、**正文强调**以及完整消息尾部均须保留。'
const plain = '这是一条普通用户消息，仍应自然排列并保持完整。'
const wire = renderAgentMuxMessageReferences([{ senderSessionId, messageId }])
const original: DurableAgentMuxMessage = { sequence: 1, envelope: {
  schema: 'agentmux.a2a.v1', messageId, operationId: 'layout-operation', createdAt: 0,
  sender: { kind: 'agent-session', agentSessionId: senderSessionId }, recipient: { kind: 'agent-session', agentSessionId: recipientSessionId },
  threadId: null, correlationId: null, replyTo: null, workspaceId: null, senderSessionId, senderRunId: 'layout-sender-run',
  recipientSessionId, recipientRunId: 'layout-recipient-run', body
}, delivery: { state: 'queued', at: 0 }, deliveryMode: 'reference' }
const calls: unknown[] = [], copies: string[] = []
api.sessions.readMessage = async (reference, id) => { calls.push({ reference, id }); return { hostId, message: original } }
api.ui.writeClipboardText = async text => { copies.push(text) }
const describeSpeaker = () => ({ name: 'Browser 内发光 Agent', providerId: 'codex' as const })
const variants = ['human', 'other-agent', 'compact', 'progress', 'system', 'collaboration'] as const
const collaboration = { kind: 'message', source: { providerId: 'codex', nativeSessionId: 'layout-native' }, sender: 'review/worker', recipient: 'review' } as const
type Variant = typeof variants[number]
let select!: (variant: Variant) => void
function Scene() {
  const [variant, setVariant] = useState<Variant>('system'); select = setVariant
  const speaker = variant === 'human' ? { role: 'human' as const } : variant === 'system' ? { role: 'system' as const }
    : { role: 'agent' as const, id: variant === 'other-agent' ? 'layout-peer' : recipientSessionId }
  return <DesktopClientUiProvider><main className="original-reading-probe" data-layout-case={variant}>
    <section className="original-reading-probe__messages" data-layout-nested key={variant}>
      <ConversationMessage messageId="layout-notice" a2aNotificationId="layout-notice" executionHostId={hostId}
        conversationSessionId={recipientSessionId} content={wire} speaker={speaker} describeSpeaker={describeSpeaker} createdAt={0}
        compact={variant === 'compact' || variant === 'collaboration'} nativeCollaboration={variant === 'collaboration' ? collaboration : undefined}
        messagePhase={variant === 'progress' ? 'progress' : undefined} />
    </section>
    <section className="original-reading-probe__messages" data-layout-standalone>
      <ConversationMessage messageId={messageId} compact recordedIdentity expandedContent executionHostId={hostId}
        conversationSessionId={recipientSessionId} content={body} contentBoundary="body" speaker={{ role: 'agent', id: senderSessionId }}
        describeSpeaker={describeSpeaker} createdAt={0} />
    </section>
    <section className="original-reading-probe__messages" data-layout-plain>
      <ConversationMessage messageId="layout-plain" content={plain} speaker={{ role: 'human' }} createdAt={0} />
    </section>
  </main></DesktopClientUiProvider>
}
mountThemeRuntime(window, { appAppearance: 'dark' })
Object.assign(window, { messageLayout: { variants, calls, copies, body, plain, wire, hostId, recipientSessionId, senderSessionId, messageId,
  select(variant: Variant) { if (!variants.includes(variant)) throw new Error('Unknown layout case'); calls.length = 0; copies.length = 0; flushSync(() => select(variant)) }
} })
createRoot(document.getElementById('root')!).render(<Scene />)
