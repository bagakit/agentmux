import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxAgentSession, AgentSessionUserMessage } from '@agentmux/core'
import { ConversationMessage, speakerOfUserMessage, type ClientUiPlatform, type DescribeSpeaker } from '@agentmux/client-ui'
import type { ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import { InputHistoryList, type InputHistoryLocalEntry } from '@agentmux/client-ui/components/InputHistoryList'
import { useAgentInputHistory, type InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'

const ThemeObjectMailboxIcon = semanticIconComponent('object.mailbox')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')



/** A client presentation of original Core messages and state, never a second mailbox owner. */
export function MobileMailbox({ session, connected, messages, platform, describeSpeaker, refresh, terminal,
  historyScope, readHistory, onHistoryFill, onHistoryCopy, localEntries = [], onHistoryFillLocal, reading, visible = true }: {
  session: AgentMuxAgentSession | null; connected: boolean; messages: readonly AgentSessionUserMessage[]; platform: ClientUiPlatform;
  describeSpeaker: DescribeSpeaker; refresh(): void; terminal?: () => void
  historyScope: string; readHistory: InputHistoryRead; reading?: ConversationReadingProps; visible?: boolean
  onHistoryFill(message: AgentSessionUserMessage, signal: AbortSignal): Promise<string | void>
  onHistoryCopy(message: AgentSessionUserMessage, signal: AbortSignal): Promise<boolean>
  localEntries?: readonly InputHistoryLocalEntry[]
  onHistoryFillLocal?(entry: InputHistoryLocalEntry): void
}) {
  const [open, setOpen] = useState(false)
  const action = useRef<AbortController | null>(null)
  const history = useAgentInputHistory({ scope: historyScope, enabled: open && visible, read: readHistory, initialMessages: messages })
  useEffect(() => {
    action.current?.abort()
    return () => { action.current?.abort() }
  }, [historyScope])
  function changeOpen(next: boolean) {
    if (!next) action.current?.abort()
    setOpen(next)
  }
  useEffect(() => { if (!visible) changeOpen(false) }, [visible])
  function originalAction<T>(message: AgentSessionUserMessage, run: (message: AgentSessionUserMessage, signal: AbortSignal) => Promise<T>) {
    action.current?.abort()
    const controller = new AbortController(); action.current = controller
    return run(message, controller.signal)
  }
  const state = session?.semanticStatus?.state
  const stateLabels: Readonly<Record<string, string>> = { working: '执行中', running: '状态未确认', starting: '启动中', waiting: '等待输入', blocked: '需要处理', done: '已完成', error: '出错', exited: '已结束', disconnected: '状态未知' }
  const label = !connected ? '连接中断 · 最近状态保留' : session?.pendingInteraction ? '需要回应' : stateLabels[state ?? ''] ?? '状态未知'
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger className="mobile-message-tools__trigger" aria-label={`通信记录 · ${label}`}><ThemeObjectMailboxIcon size={18} /><i data-state={state ?? 'unknown'} /></Dialog.Trigger>
    <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-message-tools" aria-describedby="mobile-message-tools-description">
      <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>通信记录</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭通信记录"><SemanticIcon name="action.close" size={19} /></Dialog.Close></div>
      <Dialog.Description id="mobile-message-tools-description">{session?.providerId ?? 'Agent'} · {label}</Dialog.Description>
      <div className="mobile-message-tools__actions"><button className="mobile-text-button" onClick={() => { refresh(); history.search() }}><ThemeActionRefreshIcon size={16} />刷新消息</button>{terminal && <button className="mobile-text-button" onClick={() => { changeOpen(false); terminal() }}><ThemeObjectTerminalIcon size={16} />查看 Terminal</button>}</div>
      <section className="mobile-message-tools__records" aria-label="通信记录">
        <InputHistoryList history={history} localEntries={localEntries} {...(onHistoryFillLocal ? { onFillLocal: onHistoryFillLocal } : {})} onFill={message => originalAction(message, onHistoryFill)}
          onCopy={message => originalAction(message, onHistoryCopy)} onRead={message => <ConversationMessage {...reading}
            messageId={message.id} conversationSessionId={message.agentSessionId}
            content={message.contentParts.length ? message.contentParts : message.content} inputSource={message.source}
            speaker={speakerOfUserMessage(message)} describeSpeaker={describeSpeaker}
            {...(message.source.kind === 'native' ? { nativeResourceRecord: { source: { providerId: message.source.providerId, nativeSessionId: message.source.nativeSessionId }, recordId: message.source.recordId,
              ...(message.turnId === undefined ? {} : { turnId: message.turnId }) } } : {})}
            {...(message.deliveryStatus ? { status: message.deliveryStatus } : {})}
            {...(message.recordedAt === undefined ? {} : { createdAt: message.recordedAt })} />} />
      </section>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
