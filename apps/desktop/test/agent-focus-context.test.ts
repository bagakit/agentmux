import { describe, expect, it } from 'vitest'
import {
  EMPTY_AGENT_FOCUS,
  executionFocusHistory,
  executionFocusContextText,
  focusExecution,
  focusLaneForSession,
  focusPmo,
  recordExecutionFocus,
  restoreAgentFocus
} from '../src/renderer/src/lib/agent-focus.js'

function entry(sessionId: string, focusedAt: number) {
  return { sessionId, focusedAt }
}

describe('Agent focus context', () => {
  it('records a bounded event sequence without erasing revisits', () => {
    const history = recordExecutionFocus([
      entry('older', 1), entry('current', 2)
    ], 'current', 3, 2)
    expect(history).toEqual([entry('current', 3), entry('older', 1)])
    expect(recordExecutionFocus(history, 'newest', 4, 2)).toEqual([entry('newest', 4), entry('current', 3)])
  })

  it('keeps 2000 switch events, derives MRU12 and ignores repeated selection inside one Context', () => {
    let focus = focusExecution(EMPTY_AGENT_FOCUS, 'zero', 0)
    for (let index = 1; index <= 2001; index++) focus = focusExecution(focus, `s${index % 20}`, index)
    expect(focus.execution.history).toHaveLength(2000)
    expect(focus.execution.history.at(-1)).toEqual(entry('s2', 2))
    expect(executionFocusHistory(focus)).toEqual(Array.from({ length: 12 }, (_, index) => entry(`s${(2001 - index) % 20}`, 2001 - index)))
    expect(focusExecution(focus, focus.execution.sessionId, 3000)).toBe(focus)
    expect(restoreAgentFocus(focus)).toEqual(focus)
    expect(restoreAgentFocus({ execution: { sessionId: 'missing', history: [] } }).execution.history).toEqual([])
  })

  it('keeps PMO focus outside execution history', () => {
    const execution = focusExecution(EMPTY_AGENT_FOCUS, 'exec-1', 10)
    const context = focusPmo(execution, 'pmo-1')
    expect(context).toEqual({
      execution: { sessionId: 'exec-1', history: [entry('exec-1', 10)] },
      pmo: { sessionId: 'pmo-1' }
    })
  })

  it('restores malformed durable data into a bounded typed context', () => {
    expect(restoreAgentFocus({
      execution: {
        sessionId: 'exec-1',
        history: [entry('exec-1', 1), { sessionId: '', focusedAt: 2 }, { sessionId: 'exec-2', focusedAt: 'bad' }]
      },
      pmo: { sessionId: 'pmo-1' }
    })).toEqual({
      execution: { sessionId: 'exec-1', history: [entry('exec-1', 1)] },
      pmo: { sessionId: 'pmo-1' }
    })
  })

  it('exposes execution context as read-only PMO input without PMO identity', () => {
    const text = executionFocusContextText({
      execution: { sessionId: 'exec-1', history: [entry('exec-1', 1)] },
      pmo: { sessionId: 'pmo-1' }
    }, [
      { id: 'exec-1', label: 'Build Agent', workspacePath: '/project', status: { state: 'working' } } as never,
      { id: 'pmo-1', label: 'PMO', workspacePath: '/scratch', status: { state: 'working' } } as never
    ])
    expect(text).toContain('Build Agent (exec-1)')
    expect(text).not.toContain('pmo-1')
  })

  it('classifies default and SOUL Motes from raw Topic facts while unknown identity keeps its lane', () => {
    const topic = { id: 'launcher:other', title: 'Other', directoryPath: '/scratch/topic--launcher--other',
      topicPath: '/scratch/topic--launcher--other/topic.md', summary: '', collaborators: [] }
    expect(focusLaneForSession('launcher:leader', [topic])).toBe('pmo')
    expect(focusLaneForSession('launcher:other', [topic])).toBe('execution')
    expect(focusLaneForSession('launcher:other', [{ ...topic, soul: { path: '/scratch/SOUL.md', content: '# Identity', version: 'v1' } }])).toBe('pmo')
    expect(focusLaneForSession('launcher:other', null)).toBeNull()
    expect(focusLaneForSession(null, [topic])).toBe('execution')
  })
})
