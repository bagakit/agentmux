import { afterEach, expect, it, vi } from 'vitest'
import { observeDesktopGoalChanges } from '../../desktop/src/main/desktop-goals.js'
import type { AgentMuxRpcSubscriptionOptions } from '@agentmux/core'

afterEach(() => { vi.useRealTimers() })
it('a reader closed while opening cannot claim success or prevent reconnection, and its late events cannot replace the current reader', async () => {
  vi.useFakeTimers()
  const readers: AgentMuxRpcSubscriptionOptions<'goal.watch'>[] = [], disposals = [vi.fn(), vi.fn()]
  const watchGoalChanges = vi.fn(async (handlers: AgentMuxRpcSubscriptionOptions<'goal.watch'>) => {
    readers.push(handlers); handlers.onInitial({ goalIds: ['original-goal'] })
    if (readers.length === 1) handlers.onEnd?.(new Error('Original reader ended while its opening was returning.'))
    return { dispose: disposals[readers.length - 1]! } as never
  })
  const changed = vi.fn(), issue = vi.fn(), close = observeDesktopGoalChanges({ watchGoalChanges }, changed, issue)
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(disposals[0]).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalledWith('')
    await vi.advanceTimersByTimeAsync(1000)
    expect(watchGoalChanges).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledWith(['original-goal'], true)
    const originalCalls = changed.mock.calls.length, originalIssues = issue.mock.calls.length
    readers[0]!.onEvent({ type: 'change', data: { goalIds: ['stale-goal'] } } as never)
    readers[0]!.onEnd?.(new Error('Late old reader callback.'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed).toHaveBeenCalledTimes(originalCalls); expect(issue).toHaveBeenCalledTimes(originalIssues); expect(watchGoalChanges).toHaveBeenCalledTimes(2)
  } finally { await close() }
  expect(disposals[1]).toHaveBeenCalledOnce()
})
