import { publicGoalRecord } from '@agentmux/host/goal-projection'
import { callPublicGoalControl, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { AgentMuxControlRequest } from '@agentmux/core/control'
import type { RuntimeController } from './runtime-controller.js'

/** The Desktop borrows the same Goal owner as every other client. */
export function desktopGoalControl(runtime: Pick<RuntimeController, 'callOriginalCore'>) {
  return (request: AgentMuxControlRequest, context: AgentMuxRpcCallContext = { principal: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'current') } }) =>
    callPublicGoalControl(request, (method, params) => runtime.callOriginalCore('local', method, params as never, context))
}

/** Public readers and the workbench observe the same original domain invalidations. */
export function desktopGoalChanges(runtime: Pick<RuntimeController, 'watchGoalChanges'>): import('@agentmux/core').GoalChangePort {
  return { subscribe: async (changed, ended, signal) => {
    let initial: import('@agentmux/core').GoalChanges | undefined
    const subscription = await runtime.watchGoalChanges({ signal, onInitial: value => { initial = value },
      onEvent: event => { if (event.type === 'change') void changed(event.data); else if (event.type === 'error') void ended(new Error(event.error.message)); else if (event.type === 'end') void ended() },
      onEnd: error => { void ended(error) } })
    if (!initial) { await subscription.dispose(); throw new Error('The original Goal watch has no confirmed opening. Keep its retained records and reconnect this reader.') }
    return { initial, dispose: () => subscription.dispose() }
  } }
}

/** One workbench reader; a failed observation never cancels domain work or manual input. */
export function observeDesktopGoalChanges(runtime: Pick<RuntimeController, 'watchGoalChanges'>, changed: (ids: string[], snapshot: boolean) => void, issue: (message: string) => void) {
  const controller = new AbortController()
  let subscription: Awaited<ReturnType<import('@agentmux/core').GoalChangePort['subscribe']>> | undefined, retry: ReturnType<typeof setTimeout> | undefined
  let current: object | undefined
  const reconnect = (source: object, error?: Error) => {
    if (controller.signal.aborted || current !== source) return
    current = undefined
    issue(error?.message ?? 'The original Goal reader ended. Retained Goals and healthy Agents remain available; reconnecting this reader.')
    const original = subscription; subscription = undefined; void original?.dispose()
    if (!retry) retry = setTimeout(() => { retry = undefined; void open() }, 1000)
  }
  const open = async () => {
    if (current || subscription || controller.signal.aborted) return
    const source = {}; current = source
    try {
      const next = await desktopGoalChanges(runtime).subscribe(value => { if (current === source) changed(value.goalIds, false) }, error => reconnect(source, error), controller.signal)
      if (controller.signal.aborted || current !== source) { await next.dispose(); return }
      subscription = next; changed(next.initial.goalIds, true); issue('')
    } catch (error) { reconnect(source, error instanceof Error ? error : new Error(String(error))) }
  }
  void open()
  return async () => { current = undefined; controller.abort(); if (retry) clearTimeout(retry); await subscription?.dispose() }
}

export async function readDesktopGoals(runtime: Pick<RuntimeController, 'callOriginalCore'>) {
  return (await runtime.callOriginalCore('local', 'goal.ls', { all: true }, { principal: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'current') } })).goals.map(publicGoalRecord)
}

export async function confirmDesktopGoalParticipation(runtime: Pick<RuntimeController, 'callOriginalCore'>,
  input: import('@agentmux/core').GoalParticipationConfirm) {
  const result = await runtime.callOriginalCore('local', 'goal.participation.confirm', input,
    { principal: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'current') } })
  return { demand: publicGoalRecord(result.goal) }
}

/** An observation of one retained input never becomes another Start. */
export async function reconcileDesktopGoalDispatch(runtime: Pick<RuntimeController, 'callOriginalCore'>, reference: { goalId: string; operationId: string }) {
  const result = await runtime.callOriginalCore('local', 'goal.inspect', { goalId: reference.goalId, dispatchOperationId: reference.operationId },
    { principal: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'current') } })
  if (!result.goal) throw new Error('The original Goal dispatch is unavailable. Its input operation was not repeated.')
  return { demand: publicGoalRecord(result.goal) }
}
