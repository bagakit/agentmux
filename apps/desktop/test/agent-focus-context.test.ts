import { describe, expect, it } from 'vitest'
import {
  EMPTY_AGENT_FOCUS,
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
  it('records a unique bounded execution history like a git ref log', () => {
    const history = recordExecutionFocus([
      entry('older', 1), entry('current', 2)
    ], 'current', 3, 2)
    expect(history).toEqual([entry('current', 3), entry('older', 1)])
    expect(recordExecutionFocus(history, 'newest', 4, 2)).toEqual([entry('newest', 4), entry('current', 3)])
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

  it('classifies only the fixed PMO Topic into the PMO lane', () => {
    expect(focusLaneForSession('launcher:leader', 'launcher:leader')).toBe('pmo')
    expect(focusLaneForSession('launcher:other', 'launcher:leader')).toBe('execution')
    expect(focusLaneForSession(null, 'launcher:leader')).toBe('execution')
  })
})
