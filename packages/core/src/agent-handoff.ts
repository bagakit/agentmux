/**
 * 交出去（Handoff）与派出去（Dispatch）。
 *
 * 两者的区别只有一个，但它决定了**谁在等**：
 *   - **Handoff** 是交出去——交完原 Owner 就不再等了，责任跟着工作一起走；
 *   - **Dispatch** 是派出去——派完原 Owner 仍然担着，要接问题、接升级、接收工、负责收尾。
 *
 * 把两者混成一件事，就会出现"我以为你在管、你以为我交出去了"的悬空工作。
 *
 * Core 只持有**通信事实**：谁派给谁、发生过哪些事件。它不做自动调度、不选 Agent、
 * 不评判结果——那些是 Core 之上的事。
 */

export type HandoffResult = {
  readonly ownerAgentSessionId: string
  /** 交出去之后原 Owner 不再等待。这是 Handoff 与 Dispatch 唯一的分界。 */
  readonly originAwaits: false
  readonly taskId: string
  readonly at: number
}

export function handOff(input: {
  fromAgentSessionId: string
  toAgentSessionId: string
  taskId: string
  at: number
}): HandoffResult {
  return Object.freeze({
    ownerAgentSessionId: input.toAgentSessionId,
    originAwaits: false as const,
    taskId: input.taskId,
    at: input.at
  })
}

/** 一次派发里 Owner 仍需负责的四件事。 */
export type DispatchEventKind = 'question' | 'escalation' | 'worker_done' | 'cleanup'

export type DispatchEvent = {
  readonly kind: DispatchEventKind
  /** 由 dispatch + attempt + kind 派生，因此重放同一事件不会产生第二条记录。 */
  readonly correlationId: string
  readonly at: number
}

export type Dispatch = {
  readonly dispatchId: string
  /** 所有权始终留在派发方——派出去不是交出去。 */
  readonly ownerAgentSessionId: string
  readonly workerAgentSessionId: string
  readonly taskId: string
  /** 同一个 Task 重试一次是另一回事，故 attempt 参与身份。 */
  readonly attempt: number
  readonly originAwaits: boolean
  readonly events: readonly DispatchEvent[]
}

export function openDispatch(input: {
  dispatchId: string
  ownerAgentSessionId: string
  workerAgentSessionId: string
  taskId: string
  attempt: number
  at: number
}): Dispatch {
  return Object.freeze({
    dispatchId: input.dispatchId,
    ownerAgentSessionId: input.ownerAgentSessionId,
    workerAgentSessionId: input.workerAgentSessionId,
    taskId: input.taskId,
    attempt: input.attempt,
    // 派出去了，但还等着结果。
    originAwaits: true,
    events: Object.freeze([])
  })
}

function correlationIdFor(dispatch: Dispatch, kind: DispatchEventKind): string {
  return `${dispatch.dispatchId}:${dispatch.attempt}:${kind}`
}

export function recordDispatchEvent(
  dispatch: Dispatch,
  kind: DispatchEventKind,
  at: number
): Dispatch {
  const correlationId = correlationIdFor(dispatch, kind)
  // 重放同一事件是幂等的：时刻保留第一次的，那才是它真正发生的时候。
  if (dispatch.events.some((event) => event.correlationId === correlationId)) return dispatch
  return Object.freeze({
    ...dispatch,
    // 只有收工才解除等待。提问与升级恰恰是 Owner 该处理的事，不解除。
    originAwaits: kind === 'worker_done' ? false : dispatch.originAwaits,
    events: Object.freeze([...dispatch.events, Object.freeze({ kind, correlationId, at })])
  })
}
