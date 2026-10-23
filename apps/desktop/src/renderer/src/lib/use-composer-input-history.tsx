import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { AgentSessionUserMessage, AgentSessionHistoryResourceRequest } from '@agentmux/core'
import { createCapturedInputSelector } from './session-captured-inputs'
import { useAgentInputHistory, type InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'
import { inputHistoryText } from '@agentmux/client-ui/input-history-text'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import type { AgentSessionControl, AgentTimelineSnapshot } from '../../../shared/contracts'
import { api } from './api'
import { copyTextToClipboard } from './clipboard-copy'
import { useAppStore } from '../store'
import { useSessionUserMessages } from './session-user-messages'
import { userInputHistoryMessages } from './user-input-history'
import { projectSessionInputs } from '@agentmux/core/conversation'

const EMPTY: readonly string[] = Object.freeze([])
const EMPTY_MESSAGES: readonly AgentSessionUserMessage[] = Object.freeze([])
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
  const sid = control?.agentSessionId ?? sessionId
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
  const selectCaptured = useMemo(createCapturedInputSelector, [])
  const captured = useMemo(() => selectCaptured(sid, timeline, control?.hostId),
    [selectCaptured, sid, timeline, timeline?.revision, control?.hostId])
  // The original live reader retains input facts independently of its clipped continuous page.
  const nativeMessages = native.sourceMessages.length ? native.sourceMessages : EMPTY_MESSAGES
  const initialMessages = useMemo(() => [...nativeMessages, ...captured], [nativeMessages, captured])
  const history = useAgentInputHistory({ scope, enabled, read, initialMessages })
  // Apply the current accepted entity membership after every original query/page,
  // including search. Raw source seeds never acquire an author of their own.
  const userMessages = useMemo(() => userInputHistoryMessages(history.messages, native.messages,
    { hostId: control?.hostId ?? '', agentSessionId: sid }), [history.messages, native.messages, control?.hostId, sid])
  const userHistory = { ...history, messages: userMessages, loading: history.loading || native.loading }
  // Recheck both original source-query records and their canonical membership.
  const refresh = useCallback(() => {
    history.refresh()
    return native.refresh()
  }, [history.refresh, native.refresh])
  const sourceHosts = new Set([history.sourceHostId, native.conversation?.reading?.timeline.reference?.hostId,
    ...native.messages.map(input => input.sourceHostId)].filter((host): host is string => Boolean(host)))
  const sourceHostId = sourceHosts.size === 1 ? [...sourceHosts][0] : undefined
  const groups = useMemo(() => projectSessionInputs({ hostId: control?.hostId ?? '', agentSessionId: sid,
    ...(sourceHostId ? { sourceHostId } : {}), messages: userMessages, inputs: native.messages }),
  [control?.hostId, sid, sourceHostId, userMessages, native.messages])
  useEffect(() => () => action.current?.abort(), [scope, visible, mailboxOpen, history.query])
  const local = useAppStore(state => state.agentComposerHistory[sessionId] ?? EMPTY)
  const entries = useMemo(() => [...groups.flatMap(group => group.primary ? [group.primary] : []).filter(message =>
    message.contentParts.every(part => part.kind === 'text')).map(message => message.content).reverse(), ...local], [local, groups])
  const resourceReader = useCallback(async (request: AgentSessionHistoryResourceRequest) => {
    if (!control) throw new Error('原 Agent 资源来源未提供。')
    return api.sessions.historyResource(control, request)
  }, [control?.hostId, sid])
  function beginAction(filling: boolean) {
    if (latest.current.scope !== scope) throw new Error('已切换 Agent，原记录保留。')
    if (!latest.current.visible) throw new Error('已离开原工作面，原记录与草稿保留。')
    if (filling && latest.current.readOnly) throw new Error('当前工作面只读，原记录仍可阅读和复制。')
    action.current?.abort()
    const controller = new AbortController(); action.current = controller
    const editor = insertion.current
    if (filling && !editor) throw new Error('原编辑器尚未可用，草稿未改变。')
    return { controller, editor }
  }
  function assertCurrent(controller: AbortController, editor?: ComposerInsertionHandle | null) {
    controller.signal.throwIfAborted()
    if (latest.current.scope !== scope || !latest.current.visible) throw new Error('已离开原 Agent，草稿未改变。')
    if (editor && (latest.current.readOnly || insertion.current !== editor)) throw new Error('原编辑器已改变，当前草稿保留。')
  }
  function assertMessage(message: AgentSessionUserMessage) {
    if (message.agentSessionId !== sid) throw new Error('这条记录不属于原 Agent，草稿未改变。')
  }
  const fill = async (message: AgentSessionUserMessage) => {
    assertMessage(message)
    const { controller, editor } = beginAction(true)
    let attachments = false
    // Capture the maintained caret before reading. The editor maps it through later edits.
    await editor!.insert(async () => {
      const result = await inputHistoryText(message, resourceReader, controller.signal)
      assertCurrent(controller, editor)
      attachments = result.attachments
      return result.text
    }, { separate: true })
    return attachments ? '已插入正文，尚未发送；附件仍在原记录' : undefined
  }
  const fillText = async (text: string | (() => Promise<string>)) => {
    const { controller, editor } = beginAction(true)
    await editor!.insert(async () => {
      const content = typeof text === 'function' ? await text() : text
      assertCurrent(controller, editor)
      return content
    }, { separate: true })
  }
  const fillLocal = async (entry: { text: string }) => fillText(entry.text)
  const copy = async (message: AgentSessionUserMessage) => {
    assertMessage(message)
    const { controller } = beginAction(false)
    const result = await inputHistoryText(message, resourceReader, controller.signal)
    assertCurrent(controller)
    return copyRecordedText(result.originalText)
  }
  return { history: userHistory, localEntries: local.map((text, index) => ({ id: `local:${scope}:${index}`, text })).reverse(),
    fill, fillText, fillLocal, copy, canFill: visible && !readOnly, resourceReader,
    nativeReading: { error: native.error, observationError: native.observationError, windowFrozen: native.windowFrozen, refresh },
    entries, messages: userMessages, sourceMessages: history.messages, inputs: native.messages, sourceHostId, setMailboxOpen, setFocused }
}
