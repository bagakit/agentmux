import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from 'react'
import type { AgentSessionUserMessage, AgentSessionHistoryResourceRequest } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { useAgentInputHistory, type InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'
import { inputHistoryText } from '@agentmux/client-ui/input-history-text'
import { InputHistoryList } from '@agentmux/client-ui/components/InputHistoryList'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import type { AgentSessionControl, AgentTimelineSnapshot } from '../../../shared/contracts'
import { api } from './api'
import { copyTextToClipboard } from './clipboard-copy'
import { useAppStore } from '../store'
import { useSessionUserMessages } from './session-user-messages'

const EMPTY: readonly string[] = Object.freeze([])
async function copyRecordedText(text: string): Promise<boolean> {
  let failure: unknown
  const copied = await copyTextToClipboard(text, error => { failure = error })
  if (!copied) throw failure ?? new Error('复制未完成，原记录保留。')
  return copied
}

/** The current editor consumes original history; it owns neither transcripts nor input receipts. */
export function useComposerInputHistory({ sessionId, control, visible, readOnly, insertion, timeline }: {
  sessionId: string
  control: AgentSessionControl | undefined; visible: boolean; readOnly: boolean
  insertion: RefObject<ComposerInsertionHandle | null>; timeline?: AgentTimelineSnapshot
}) {
  const [focused, setFocused] = useState(false), [mailboxOpen, setMailboxOpen] = useState(false)
  const sid = control?.agentSessionId ?? ''
  const scope = JSON.stringify([control?.hostId, sid])
  const latest = useRef({ scope, visible, readOnly })
  latest.current = { scope, visible, readOnly }
  const action = useRef<AbortController | null>(null)
  const read = useCallback<InputHistoryRead>((input, signal) => {
    if (!control) return Promise.reject(new Error('当前 Agent 历史引用未提供。草稿仍可使用。'))
    return api.sessions.readHistory({ hostId: control.hostId, agentSessionId: control.agentSessionId }, input, { signal }).then(page => {
      if (page.hostId !== control.hostId || page.agentSessionId !== sid) throw new Error('历史结果不属于当前 Agent，原草稿和发送能力保留。')
      return page
    })
  }, [control?.hostId, sid])
  const enabled = visible && Boolean(control) && (focused || mailboxOpen)
  // Reuse the existing scoped live reader. Both consumers share its original watch and page.
  const native = useSessionUserMessages(control, { enabled })
  const captured = useMemo(() => sid ? projectSessionUserMessages({ agentSessionId: sid, timeline }) : [], [sid, timeline])
  // The original live reader retains input facts independently of its clipped continuous page.
  const initialMessages = [...native.messages.filter(message => message.source.kind === 'native'), ...captured]
  const history = useAgentInputHistory({ scope, enabled, read, initialMessages })
  useEffect(() => () => action.current?.abort(), [scope, visible, mailboxOpen, history.query])
  const local = useAppStore(state => state.agentComposerHistory[sessionId] ?? EMPTY)
  const entries = useMemo(() => [...history.messages.filter(message => message.author.kind !== 'agent' &&
    message.contentParts.every(part => part.kind === 'text')).map(message => message.content).reverse(), ...local], [local, history.messages])
  const resourceReader = useCallback(async (request: AgentSessionHistoryResourceRequest) => {
    if (!control) throw new Error('原 Agent 资源来源未提供。')
    return api.sessions.historyResource(control, request)
  }, [control?.hostId, sid])
  async function textForAction(message: AgentSessionUserMessage, filling: boolean) {
    if (!control || message.agentSessionId !== sid || latest.current.scope !== scope) throw new Error('已切换 Agent，原记录保留。')
    if (filling && (readOnly || !visible)) throw new Error('当前工作面只读，原记录仍可阅读和复制。')
    action.current?.abort()
    const controller = new AbortController(); action.current = controller
    const draft = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
    const editor = insertion.current
    const result = await inputHistoryText(message, resourceReader, controller.signal)
    controller.signal.throwIfAborted()
    if (latest.current.scope !== scope || !latest.current.visible || message.agentSessionId !== sid) throw new Error('已离开原 Agent，草稿未改变。')
    if (filling && (latest.current.readOnly || (useAppStore.getState().agentComposerDrafts[sessionId] ?? '') !== draft)) {
      throw new Error('读取期间草稿已改变，新稿已保留。请重新选择回填。')
    }
    return { ...result, controller, draft, editor }
  }
  const fill = async (message: AgentSessionUserMessage) => {
    const result = await textForAction(message, true)
    result.controller.signal.throwIfAborted()
    if (latest.current.scope !== scope || !latest.current.visible || latest.current.readOnly ||
      (useAppStore.getState().agentComposerDrafts[sessionId] ?? '') !== result.draft || insertion.current !== result.editor) {
      throw new Error('读取期间工作面或草稿已改变，新稿已保留。请重新选择回填。')
    }
    if (!result.editor) throw new Error('原编辑器尚未可用，草稿未改变。')
    result.editor.replace(result.text)
    return result.attachments ? '已填入正文，尚未发送；附件仍在原记录' : undefined
  }
  const copy = async (message: AgentSessionUserMessage) => {
    const result = await textForAction(message, false)
    result.controller.signal.throwIfAborted()
    if (latest.current.scope !== scope || !latest.current.visible) throw new Error('已离开原 Agent，原记录保留。')
    return copyRecordedText(result.text)
  }
  const render = (onRead: (message: AgentSessionUserMessage) => ReactNode) => <InputHistoryList key={scope} history={history}
    localEntries={local.map((text, index) => ({ id: `local:${scope}:${index}`, text })).reverse()}
    onCopy={copy} {...(!readOnly && visible ? { onFill: fill, onFillLocal: (entry: { text: string }) => {
      if (latest.current.scope !== scope || !latest.current.visible || latest.current.readOnly || !insertion.current) throw new Error('原编辑器暂不可用，草稿未改变。')
      insertion.current.replace(entry.text)
    } } : {})}
    onRead={onRead} />
  return { render, resourceReader, entries, messages: history.messages, setMailboxOpen, setFocused }
}
