import { useCallback, useEffect, useRef, useState } from 'react'
import { consumeAgentInputMailboxEntry, parseAgentInputMailboxPage,
  type AgentInputMailboxItem, type AgentInputMailboxPage, type AgentInputMailboxRead } from '@agentmux/core/agent-input-mailbox'
import type { JsonReadAssembly } from '@agentmux/core/conversation'
import { conversationRevision } from '@agentmux/core/conversation'
import { agentPromptInputId, type AgentPromptInputKey } from '@agentmux/core/prompt-condition'

export type InputMailboxRead = (input: AgentInputMailboxRead, signal: AbortSignal) => Promise<AgentInputMailboxPage>
export const inputMailboxKey = (hostId: string, key: AgentPromptInputKey) =>
  JSON.stringify([hostId, key.agentSessionId, key.expectedRun.runId, key.kind, agentPromptInputId(key)])
export const inputMailboxItemKey = (hostId: string, item: AgentInputMailboxItem) =>
  inputMailboxKey(hostId, item.kind === 'controlled' ? item.intent.key : item.key)
type Window = { scope: string; items: readonly AgentInputMailboxItem[]; failures: readonly AgentInputMailboxItem[]; page: AgentInputMailboxPage | null; loading: boolean; error: string | null }
const empty = (scope: string): Window => ({ scope, items: [], failures: [], page: null, loading: false, error: null })
const sameSource = (a: AgentInputMailboxPage, b: AgentInputMailboxPage) => a.queueId === b.queueId && a.cut.incarnation === b.cut.incarnation
const sameCut = (a: AgentInputMailboxPage, b: AgentInputMailboxPage) => sameSource(a,b) && a.cut.throughSequence === b.cut.throughSequence
function immutableContent(item: AgentInputMailboxItem): string | null {
  if (item.kind === 'controlled') return conversationRevision({ kind: item.kind, intent: item.intent,
    message: item.message, sourceChannel: item.sourceChannel, sourceDevice: item.sourceDevice })
  const intent = item.record?.admission?.intent, launch = item.record?.launch
  return intent || launch ? conversationRevision({ kind: item.kind, prompt: intent?.prompt ?? launch?.prompt, message: intent?.message ?? launch?.message }) : null
}

/** One visible consumer's bounded read window. Original input and editor intents stay with their owners. */
export function useAgentInputMailbox({ hostId, agentSessionId, enabled, read }: {
  hostId: string; agentSessionId: string; enabled: boolean; read: InputMailboxRead
}) {
  const scope = JSON.stringify([hostId, agentSessionId])
  const [state, setState] = useState<Window>(() => empty(scope))
  const stateRef = useRef(state); stateRef.current = state
  const current = useRef({ scope, read, enabled, generation: 0 }); Object.assign(current.current, { scope, read, enabled })
  const active = useRef<AbortController | null>(null)
  const load = useCallback(async (earlier = false) => {
    if (!current.current.enabled) return
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    const generation = ++current.current.generation
    const matches = () => !controller.signal.aborted && current.current.enabled && current.current.scope === scope && current.current.read === read && current.current.generation === generation
    const previous = stateRef.current.scope === scope ? stateRef.current : empty(scope)
    if (earlier && !previous.page?.nextCursor) return
    setState(value => value.scope === scope ? { ...value, loading: true, error: null } : { ...empty(scope), loading: true })
    try {
      let cursor = earlier ? previous.page!.nextCursor! : undefined, first: AgentInputMailboxPage | null = null
      let last: AgentInputMailboxPage | null = null, pending: JsonReadAssembly | undefined
      const accepted: AgentInputMailboxItem[] = [], cursors = new Set<string>()
      // Complete only this page's original byte fragments; never scan the remaining journal.
      do {
        const request = { agentSessionId, limit: 25, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }
        const result = await read(request, controller.signal)
        if (!matches()) return
        const page = parseAgentInputMailboxPage(result, request)
        if (first && !sameCut(first, page) || earlier && previous.page && !sameCut(previous.page, page) ||
            !earlier && previous.page && (!sameSource(previous.page, page) || page.cut.throughSequence < previous.page.cut.throughSequence)) {
          throw new Error('原发送信箱的来源或读取位置已变化；原窗口保留，请重新打开原来源。')
        }
        first ??= page; last = page
        for (const entry of page.items) {
          const result = consumeAgentInputMailboxEntry({ hostId, page, entry, ...(pending ? { pending } : {}) })
          if (result.kind === 'pending') pending = result.pending
          else { accepted.push(result.value); pending = undefined }
        }
        if (pending) {
          if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('原消息片段未完整读取；原记录保留。')
          cursors.add(page.nextCursor); cursor = page.nextCursor
        }
      } while (pending)
      if (!matches() || !last) return
      const priorPositions = new Map(previous.items.map(item => [inputMailboxItemKey(hostId,item),item.sequence]))
      for (const item of accepted) if (priorPositions.has(inputMailboxItemKey(hostId,item)) && priorPositions.get(inputMailboxItemKey(hostId,item)) !== item.sequence) throw new Error('原输入的登记位置已变化；原窗口保留。')
      const originals = new Map(previous.items.map(item => [inputMailboxItemKey(hostId,item),item]))
      for (const item of accepted) {
        const old = originals.get(inputMailboxItemKey(hostId,item))
        if (!old) continue
        const oldContent = immutableContent(old), nextContent = immutableContent(item)
        if (item.failure && nextContent === null || oldContent !== null && oldContent !== nextContent) {
          throw new Error(`这条原输入的不可变内容身份未确认；此前读取窗口保留。${item.failure ? '\n' + JSON.stringify(item.failure) : ''}`)
        }
      }
      setState(value => {
        if (value.scope !== scope) return value
        const records = [...value.items]
        const indices = new Map(records.map((item,index) => [inputMailboxItemKey(hostId,item),index]))
        for (const item of accepted) {
          const key = inputMailboxItemKey(hostId,item), index = indices.get(key)
          if (index === undefined) { indices.set(key, records.length); records.push(item) } else if (!item.failure) records[index] = item
        }
        records.sort((a,b) => b.sequence - a.sequence)
        const observed = new Set(accepted.map(item => inputMailboxItemKey(hostId,item)))
        const failures = [...value.failures.filter(item => !observed.has(inputMailboxItemKey(hostId,item))), ...accepted.filter(item => item.failure)]
        return { scope, items: records, failures, page: last, loading: false, error: null }
      })
    } catch (error) {
      if (matches()) setState(value => ({ ...(value.scope === scope ? value : empty(scope)), loading: false,
        error: error instanceof Error ? error.message : String(error) }))
    }
  }, [scope, hostId, agentSessionId, read])
  useEffect(() => {
    if (enabled) void load()
    return () => { ++current.current.generation; active.current?.abort() }
  }, [scope, read, enabled, load])
  const visible = state.scope === scope ? state : empty(scope)
  return { ...visible, refresh: load, loadEarlier: () => load(true), hasMore: Boolean(visible.page?.nextCursor) }
}
