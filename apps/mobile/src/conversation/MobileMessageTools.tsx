import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { MessageSquare, RefreshCw, SquareTerminal, X } from 'lucide-react'
import type { AgentMuxAgentSession, AgentSessionUserMessage } from '@agentmux/core'
import { ConversationMessage, speakerOfUserMessage, type ClientUiPlatform, type DescribeSpeaker } from '@agentmux/client-ui'

/** A client presentation of original Core messages and state, never a second mailbox owner. */
export function MobileMessageTools({ session, connected, messages, platform, describeSpeaker, refresh, terminal }: {
  session: AgentMuxAgentSession | null; connected: boolean; messages: readonly AgentSessionUserMessage[]; platform: ClientUiPlatform;
  describeSpeaker: DescribeSpeaker; refresh(): void; terminal?: () => void
}) {
  const [open, setOpen] = useState(false)
  const state = session?.semanticStatus?.state
  const stateLabels: Readonly<Record<string, string>> = { working: '执行中', running: '运行中', starting: '启动中', waiting: '等待输入', blocked: '需要处理', done: '已完成', error: '出错', exited: '已结束', disconnected: '状态未知' }
  const label = !connected ? '连接中断 · 最近状态保留' : session?.pendingInteraction ? '需要回应' : stateLabels[state ?? ''] ?? '状态未知'
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger className="mobile-message-tools__trigger" aria-label={`Message Tools · ${label}`}><MessageSquare size={18} /><i data-state={state ?? 'unknown'} /></Dialog.Trigger>
    <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-message-tools" aria-describedby="mobile-message-tools-description">
      <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>Message Tools</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭消息工具"><X size={19} /></Dialog.Close></div>
      <Dialog.Description id="mobile-message-tools-description">{session?.providerId ?? 'Agent'} · {label}</Dialog.Description>
      <div className="mobile-message-tools__actions"><button className="mobile-text-button" onClick={refresh}><RefreshCw size={16} />刷新消息</button>{terminal && <button className="mobile-text-button" onClick={() => { setOpen(false); terminal() }}><SquareTerminal size={16} />查看 Terminal</button>}</div>
      <section className="mobile-message-tools__records" aria-label="通信记录">{messages.length ? [...messages].reverse().map(message => <ConversationMessage key={message.id} messageId={message.id} conversationSessionId={message.agentSessionId}
        content={message.contentParts.length ? message.contentParts : message.content} inputSource={message.source} speaker={speakerOfUserMessage(message)} describeSpeaker={describeSpeaker}
        {...(message.deliveryStatus ? { status: message.deliveryStatus } : {})} {...(message.recordedAt === undefined ? {} : { createdAt: message.recordedAt })} />) : <p className="mobile-spatial-empty">暂无已确认的通信记录。</p>}</section>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
