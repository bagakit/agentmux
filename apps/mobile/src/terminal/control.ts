import type { AgentMuxRunInputData, AgentMuxRunRef, AgentMuxAgentWriteInput } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

type Client = Pick<AgentMuxHostedClient, 'runtimeIdentity' | 'agentSession' | 'writeAgent' | 'resizeAgent'>
type Owner = Pick<ReturnType<Client['runtimeIdentity']>, 'hostId' | 'instanceId'>
export type MobileTerminalControlState = {
  mode: 'watch' | 'control'; phase: 'idle' | 'sending' | 'unknown'
  queuedBytes: number; message: string; storageIssue: string | null
}
type Intent = { run: AgentMuxRunRef; kind: 'input'; data: AgentMuxRunInputData } |
  { run: AgentMuxRunRef; kind: 'resize'; cols: number; rows: number }
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
  let unresolved: { intentId: string; runId: string; kind: Intent['kind']; createdAt: number } | null = null
  let state: MobileTerminalControlState = { mode: 'watch', phase: 'idle', queuedBytes: 0,
    message: '观看不发送输入；PTY 尺寸沿用 Mac。', storageIssue: null }
  const publish = (change: Partial<MobileTerminalControlState>) => {
    state = { ...state, ...change }; if (!closed) report(state)
  }
  try {
    const bytes = storage().getItem(key); persisted = bytes
    if (bytes !== null) {
      const value = JSON.parse(bytes)
      if (!value || Object.keys(value).length !== 5 || value.version !== 1 || typeof value.intentId !== 'string' || !value.intentId
        || typeof value.runId !== 'string' || !value.runId
        || !['input', 'resize'].includes(value.kind) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error('Invalid original terminal intent')
      unresolved = { intentId: value.intentId, runId: value.runId, kind: value.kind, createdAt: value.createdAt }
      state = { ...state, phase: 'unknown', message: '重启前的终端操作回执未确认；不会重发。请在原会话核对后继续新输入。' }
    }
  } catch {
    canPersist = false
    state = { ...state, storageIssue: '本机终端回执记录暂时无法读取，原字节保留；新回执仅在当前页面保留。' }
  }
  function persist() {
    if (!canPersist) return
    try {
      const owner = storage()
      if (owner.getItem(key) !== persisted) {
        canPersist = false
        publish({ storageIssue: '另一页面已更新终端回执记录；原字节保留，本页不覆盖它。' }); return
      }
      const next = unresolved ? JSON.stringify({ version: 1, ...unresolved }) : null
      if (next === null) owner.removeItem(key)
      else owner.setItem(key, next)
      persisted = next
    } catch { publish({ storageIssue: '本机终端回执暂时无法保存，原记录保留；未确认操作仅在当前页面保留。' }) }
  }
  const currentFacts = () => {
    if (!currentClient) throw new Error('连接尚未恢复。')
    const identity = currentClient.runtimeIdentity(), session = currentClient.agentSession(agentSessionId)
    if (!identity.hostId || !identity.instanceId || session.agentSessionId !== agentSessionId) throw new Error('原 Host/Session 身份尚未核实。')
    return { identity: { hostId: identity.hostId, instanceId: identity.instanceId }, run: { ...session.run } }
  }
  const sameOwner = (next: Owner) => owner?.hostId === next.hostId && owner.instanceId === next.instanceId
  const unknown = () => state.phase === 'unknown'
  async function drain() {
    if (active || closed || state.mode !== 'control' || state.phase === 'unknown') return
    active = true
    try {
      while (!closed && state.mode === 'control' && !unknown() && queue.length) {
        const intent = queue[0]!
        const facts = currentFacts()
        if (!sameOwner(facts.identity) || facts.run.runId !== intent.run.runId) {
          publish({ mode: 'watch', message: '当前 Host/Run 与原输入不同；未发送的旧输入保留，不会投给另一个 owner。' }); break
        }
        // This identity protects device storage ownership only; it is never sent as a
        // Core/ctxmux operation ID or used to claim an Input receipt.
        unresolved = { intentId: crypto.randomUUID(), runId: intent.run.runId, kind: intent.kind, createdAt: Date.now() }
        persist()
        publish({ phase: 'sending', message: intent.kind === 'input' ? '正在确认原 Run 的输入回执。' : '正在确认用户选择的 PTY 尺寸。' })
        // Remove only the exact operation being dispatched. Later user bytes remain in order,
        // never inherit this receipt, and cannot be replayed after an unknown result.
        queue.shift()
        if (intent.kind === 'input') publish({ queuedBytes: state.queuedBytes - byteLength(intent.data) })
        const dispatchClient = currentClient!
        try {
          if (intent.kind === 'input') {
            const receipt = await dispatchClient.writeAgent({ agentSessionId, expectedRun: intent.run, data: intent.data, source: 'user' })
            if (receipt.runId !== intent.run.runId || receipt.appliedByteRange === null || receipt.acceptedThroughByte === null
              || receipt.appliedByteRange.endByte - receipt.appliedByteRange.startByte !== byteLength(intent.data)
              || receipt.acceptedThroughByte < receipt.appliedByteRange.endByte) throw new Error('原输入的确切应用字节尚未确认。')
          } else {
            const receipt = await dispatchClient.resizeAgent(agentSessionId, intent.run, intent.cols, intent.rows)
            if (receipt.runId !== intent.run.runId || receipt.cols !== intent.cols || receipt.rows !== intent.rows) throw new Error('原 Run 的确切尺寸回执尚未确认。')
          }
          unresolved = null; persist()
          publish({ phase: 'idle', message: intent.kind === 'input' ? 'Core 已确认这笔原生输入。观看和 Mac 输入继续使用原 Run。' : 'Core 已确认用户选择的 PTY 尺寸；手机窗口变化不会再改尺寸。' })
        } catch (error) {
          // Raw input has no caller-owned operation ID. Even an apparent transport rejection
          // cannot justify repeating its bytes; only new user intent may follow explicit review.
          publish({ phase: 'unknown', message: `终端操作回执未确认，不会重发；余下输入保留。请在 Mac 核对后继续。${error instanceof Error ? error.message : String(error)}` })
        }
      }
    } catch (error) {
      publish({ mode: 'watch', message: `原 Session/Run 尚未核实，画面与未发送输入保留。${error instanceof Error ? error.message : String(error)}` })
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
          publish({ mode: 'watch', message: '未确认操作或未发送输入属于另一 Host。原输入保留，不会发给当前 Host。' }); return false
        }
        if (queue.length && queue[0]!.run.runId !== next.runId) {
          publish({ mode: 'watch', message: '未发送输入属于旧 Run。请先复制或明确放弃这些输入，再控制新 Run。' }); return false
        }
        owner = facts.identity; run = next; publish({ mode: 'control', message: '原生输入发往这个原 Run；不会接管 Mac 的输入或自动改尺寸。' }); void drain(); return true
      } catch (error) { publish({ message: `原会话身份尚未核实，可在 Mac 继续操作。${error instanceof Error ? error.message : String(error)}` }); return false }
    },
    watch() { publish({ mode: 'watch', message: state.phase === 'unknown' ? state.message : '已回到观看；尚未发送的输入保留，正在途中的回执继续核对。' }) },
    send(data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source']) {
      if (closed || state.mode !== 'control' || !run || source !== 'user' || !data.length) return
      const bytes = byteLength(data)
      if (state.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        publish({ message: '待发输入已达本机容量；这次输入未提交。请先核对原回执，原 Run 不受影响。' }); return
      }
      queue.push({ kind: 'input', run: { ...run }, data: data instanceof Uint8Array ? data.slice() : data })
      publish({ queuedBytes: state.queuedBytes + bytes }); void drain()
    },
    resize(cols: number, rows: number) {
      if (closed || state.mode !== 'control' || !run || state.phase === 'unknown') return false
      if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) {
        publish({ message: '请填写 2–500 列和 2–300 行；尺寸尚未提交。' }); return false
      }
      if (queue.some(item => item.kind === 'resize')) { publish({ message: '已有一次尺寸操作等待回执；尚未再提交。' }); return false }
      queue.push({ kind: 'resize', run: { ...run }, cols, rows }); void drain(); return true
    },
    continueAfterReview() {
      if (closed || state.phase !== 'unknown' || active) return false
      // This explicit action never puts the uncertain operation back into the queue.
      unresolved = null; persist(); publish({ phase: 'idle', mode: 'watch', message: '原未知操作不会重发；开启控制后只发送尚未提交的余下输入。' }); return true
    },
    queuedText: () => queue.filter((intent): intent is Extract<Intent, { kind: 'input' }> => intent.kind === 'input')
      .map(intent => typeof intent.data === 'string' ? intent.data : new TextDecoder().decode(intent.data)).join(''),
    discardUnsent() { queue.length = 0; publish({ queuedBytes: 0, message: '已明确放弃尚未调用 Core 的余下输入；原未知操作没有重发。' }) },
    dispose() { closed = true; state.mode = 'watch' }
  }
}
