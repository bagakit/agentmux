import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import type { AgentMuxRunInputData, AgentMuxRunRef, AgentMuxAgentWriteInput } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

type Client = Pick<AgentMuxHostedClient, 'runtimeIdentity' | 'agentSession' | 'writeAgent' | 'resizeAgent'>
type Owner = Pick<ReturnType<Client['runtimeIdentity']>, 'hostId' | 'instanceId'>
export type MobileTerminalControlState = {
  mode: 'watch' | 'control'; phase: 'idle' | 'sending' | 'unknown'
  queuedBytes: number; message: string; notice: string | null; storageIssue: string | null
}
type Intent = { run: AgentMuxRunRef; kind: 'input'; data: AgentMuxRunInputData } |
  { run: AgentMuxRunRef; kind: 'resize'; cols: number; rows: number }
type NoticeKind = 'identity' | 'receipt' | 'capacity' | 'resize'
const MAX_QUEUED_BYTES = 256 * 1024
const byteLength = (data: AgentMuxRunInputData) => typeof data === 'string' ? new TextEncoder().encode(data).length : data.length

/** Device input intent only. The Core remains the sole Input/size owner and generates its original receipts. */
export function createMobileTerminalControl({ client, agentSessionId, report, storage = () => localStorage }: {
  client: Client; agentSessionId: string; report(state: MobileTerminalControlState): void
  storage?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}) {
  const key = `agentmux-mobile-terminal-intent-v1:${agentSessionId}`
  const queue: Intent[] = []
  let currentClient: Client | null = client, owner: Owner | null = null
  let closed = false, active = false, canPersist = true, run: AgentMuxRunRef | null = null
  let persisted: string | null = null
  let noticeKind: NoticeKind | null = null
  let unresolved: { intentId: string; runId: string; kind: Intent['kind']; createdAt: number } | null = null
  let state: MobileTerminalControlState = { mode: 'watch', phase: 'idle', queuedBytes: 0,
    message: '观看不发送输入，终端大小跟随远端。', notice: null, storageIssue: null }
  const publish = (change: Partial<MobileTerminalControlState>) => {
    state = { ...state, ...change }; if (!closed) report(state)
  }
  const problem = (kind: NoticeKind, change: Partial<MobileTerminalControlState> & { message: string }) => {
    noticeKind = kind
    publish({ ...change, notice: change.message })
  }
  const clearNotice = (...kinds: NoticeKind[]): Partial<MobileTerminalControlState> => {
    if (noticeKind === null || !kinds.includes(noticeKind)) return {}
    noticeKind = null
    return { notice: null }
  }
  try {
    const bytes = storage().getItem(key); persisted = bytes
    if (bytes !== null) {
      const value = JSON.parse(bytes)
      if (!value || Object.keys(value).length !== 5 || value.version !== 1 || typeof value.intentId !== 'string' || !value.intentId
        || typeof value.runId !== 'string' || !value.runId
        || !['input', 'resize'].includes(value.kind) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error('Invalid original terminal intent')
      unresolved = { intentId: value.intentId, runId: value.runId, kind: value.kind, createdAt: value.createdAt }
      const message = '重启前的终端操作还没确认送达，不会重发。可以在 Mac 上核对后继续输入。'
      noticeKind = 'receipt'
      state = { ...state, phase: 'unknown', message, notice: message }
    }
  } catch {
    canPersist = false
    state = { ...state, storageIssue: '暂时读不到这台手机上的终端操作记录，记录内容保持不变。新操作只记在当前页面。' }
  }
  function persist() {
    if (!canPersist) return
    try {
      const owner = storage()
      if (owner.getItem(key) !== persisted) {
        canPersist = false
        publish({ storageIssue: '另一个页面更新了终端操作记录，这个页面不会覆盖它。' }); return
      }
      const next = unresolved ? JSON.stringify({ version: 1, ...unresolved }) : null
      if (next === null) owner.removeItem(key)
      else owner.setItem(key, next)
      persisted = next
    } catch { publish({ storageIssue: '终端操作记录暂时存不到这台手机上，未确认的操作只记在当前页面。' }) }
  }
  const currentFacts = () => {
    if (!currentClient) throw new Error('连接尚未恢复。')
    const identity = currentClient.runtimeIdentity(), session = currentClient.agentSession(agentSessionId)
    if (!identity.hostId || !identity.instanceId || session.agentSessionId !== agentSessionId) throw new Error('还没确认这个对话所在的 Mac。')
    return { identity: { hostId: identity.hostId, instanceId: identity.instanceId }, run: { ...session.run } }
  }
  const sameOwner = (next: Owner) => owner?.hostId === next.hostId && owner.instanceId === next.instanceId
  const unknown = () => state.phase === 'unknown'
  async function drain() {
    if (active || closed || state.mode !== 'control' || state.phase === 'unknown') return
    active = true
    try {
      while (!closed && state.mode === 'control' && !unknown() && queue.length) {
        let intent = queue[0]!
        const facts = currentFacts()
        if (!sameOwner(facts.identity) || facts.run.runId !== intent.run.runId) {
          problem('identity', { mode: 'watch', message: '终端已换到另一次运行，之前没发出的输入不会发到新运行里。' }); break
        }
        let count = 1
        if (intent.kind === 'input') {
          const parts: Uint8Array[] = []
          for (let index = 1; index < queue.length; index++) {
            const next = queue[index]!
            if (next.kind !== 'input' || next.run.runId !== intent.run.runId) break
            parts.push(typeof next.data === 'string' ? new TextEncoder().encode(next.data) : next.data)
            count++
          }
          if (count > 1) {
            parts.unshift(typeof intent.data === 'string' ? new TextEncoder().encode(intent.data) : intent.data)
            const data = new Uint8Array(parts.reduce((bytes, part) => bytes + part.length, 0))
            let offset = 0
            for (const part of parts) { data.set(part, offset); offset += part.length }
            intent = { ...intent, data }
          }
        }
        // This identity protects device storage ownership only; it is never sent as a
        // Core/ctxmux operation ID or used to claim an Input receipt.
        unresolved = { intentId: randomClientRequestId(), runId: intent.run.runId, kind: intent.kind, createdAt: Date.now() }
        persist()
        publish({ phase: 'sending', message: intent.kind === 'input' ? '正在确认输入送达。' : '正在确认终端大小。' })
        // Only adjacent, unsent input shares this one operation. A resize remains
        // a barrier; later bytes never inherit or replay an unknown batch receipt.
        queue.splice(0, count)
        if (intent.kind === 'input') publish({ queuedBytes: state.queuedBytes - byteLength(intent.data) })
        const dispatchClient = currentClient!
        try {
          if (intent.kind === 'input') {
            const receipt = await dispatchClient.writeAgent({ agentSessionId, expectedRun: intent.run, data: intent.data, source: 'user' })
            if (receipt.runId !== intent.run.runId || receipt.appliedByteRange === null || receipt.acceptedThroughByte === null
              || receipt.appliedByteRange.endByte - receipt.appliedByteRange.startByte !== byteLength(intent.data)
              || receipt.acceptedThroughByte < receipt.appliedByteRange.endByte) throw new Error('还没确认这次输入的全部内容已送达。')
          } else {
            const receipt = await dispatchClient.resizeAgent(agentSessionId, intent.run, intent.cols, intent.rows)
            if (receipt.runId !== intent.run.runId || receipt.cols !== intent.cols || receipt.rows !== intent.rows) throw new Error('还没确认终端大小已改好。')
          }
          unresolved = null; persist()
          publish({ ...clearNotice('receipt', intent.kind === 'input' ? 'capacity' : 'resize'), phase: 'idle', message: intent.kind === 'input' ? '输入已送达。' : '终端大小已改好。手机窗口变化不会再改它。' })
        } catch (error) {
          // Raw input has no caller-owned operation ID. Even an apparent transport rejection
          // cannot justify repeating its bytes; only new user intent may follow explicit review.
          problem('receipt', { phase: 'unknown', message: `终端操作还没确认送达，不会重发。可以在 Mac 上核对后继续。${error instanceof Error ? error.message : String(error)}` })
        }
      }
    } catch (error) {
      problem('identity', { mode: 'watch', message: `还没确认这个对话的终端，未发送的输入先留在这里。${error instanceof Error ? error.message : String(error)}` })
    } finally { active = false }
  }
  report(state)
  return {
    facts: () => ({ ...state, run: run ? { ...run } : null, pending: unresolved ? { ...unresolved } : null }),
    rebind(next: Client | null) {
      // SDK replacement changes only the port. This page still owns its unsent intent;
      // every later dispatch checks the original semantic Host, Session and Run again.
      currentClient = next
      publish({ mode: 'watch', message: state.phase === 'unknown' ? state.message : '连接已变化，回到观看；未发送输入保留，控制需重新明确开启。' })
    },
    enable() {
      if (closed || state.phase === 'unknown') return false
      try {
        const facts = currentFacts(), next = facts.run
        if ((queue.length || unresolved) && !sameOwner(facts.identity)) {
          problem('identity', { mode: 'watch', message: owner?.hostId !== facts.identity.hostId
            ? '未确认或未发送的输入属于另一台 Mac，不会发给当前这台。'
            : 'Mac 上的终端服务已重新启动，不会把之前的输入发给当前终端。请先复制或放弃这些输入。' }); return false
        }
        if (queue.length && queue[0]!.run.runId !== next.runId) {
          problem('identity', { mode: 'watch', message: '未发送输入属于上一次运行。请先复制或放弃这些输入，再控制终端。' }); return false
        }
        owner = facts.identity; run = next; publish({ ...clearNotice('identity'), mode: 'control', message: '输入会发到这个终端，不会接管 Mac 上的输入，也不会自动改终端大小。' }); void drain(); return true
      } catch (error) { problem('identity', { message: `还没确认这个对话，可以在 Mac 上继续操作。${error instanceof Error ? error.message : String(error)}` }); return false }
    },
    watch() { publish({ mode: 'watch', message: state.phase === 'unknown' ? state.message : '已回到观看。' }) },
    send(data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source']) {
      if (closed || state.mode !== 'control' || !run || source !== 'user' || !data.length) return
      const bytes = byteLength(data)
      if (state.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        problem('capacity', { message: '待发输入已满，这次输入没有提交。请先等之前的输入确认送达。' }); return
      }
      queue.push({ kind: 'input', run: { ...run }, data: data instanceof Uint8Array ? data.slice() : data })
      publish({ queuedBytes: state.queuedBytes + bytes }); void drain()
    },
    resize(cols: number, rows: number) {
      if (closed || state.mode !== 'control' || !run || state.phase === 'unknown') return false
      if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) {
        problem('resize', { message: '请填写 2–500 列和 2–300 行；尺寸尚未提交。' }); return false
      }
      if (queue.some(item => item.kind === 'resize')) { problem('resize', { message: '上一次改终端大小还在等待确认，这次没有提交。' }); return false }
      queue.push({ kind: 'resize', run: { ...run }, cols, rows }); void drain(); return true
    },
    continueAfterReview() {
      if (closed || state.phase !== 'unknown' || active) return false
      // This explicit action never puts the uncertain operation back into the queue.
      unresolved = null; persist(); publish({ ...clearNotice('receipt'), phase: 'idle', mode: 'watch', message: '未确认的操作不会重发。开启控制后只发送还没提交的输入。' }); return true
    },
    queuedText: () => queue.filter((intent): intent is Extract<Intent, { kind: 'input' }> => intent.kind === 'input')
      .map(intent => typeof intent.data === 'string' ? intent.data : new TextDecoder().decode(intent.data)).join(''),
    discardUnsent() { queue.length = 0; publish({ ...clearNotice('capacity'), queuedBytes: 0, message: '已放弃未发送的输入。' }) },
    dispose() { closed = true; state.mode = 'watch' }
  }
}
