import { describe, expect, it } from 'vitest'
import {
  normalizeAgentInteractionResponse,
  normalizeTerminalInteraction,
  planNumberedTerminalInteractionResponse
} from '../src/agent-interaction.js'

const protocol = {
  questionEvents: ['PreToolUse'],
  questionTools: ['request_user_input', 'askuserquestion']
}

describe('Agent terminal interaction protocol', () => {
  it('normalizes one bounded single-select question from a native Hook', () => {
    const request = normalizeTerminalInteraction({
      receiptId: 'receipt-1',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'codex',
      eventName: 'PreToolUse',
      payload: {
        tool_name: 'request_user_input',
        tool_input: {
          questions: [{
            header: 'Scope',
            question: 'Which scope?',
            options: [
              { label: 'Focused', description: 'Only affected tests' },
              { label: 'Full', description: 'All tests' }
            ]
          }]
        }
      }
    }, 100, protocol)

    expect(request).toMatchObject({
      kind: 'question',
      id: 'receipt-1',
      agentSessionId: 'agent-1',
      questions: [{
        id: 'question-1',
        title: 'Scope',
        prompt: 'Which scope?',
        options: [{ id: 'option-1', label: 'Focused' }, { id: 'option-2', label: 'Full' }]
      }],
      evidence: { source: 'native-hook', run: { runId: 'run-1' }, hookReceiptId: 'receipt-1' }
    })
    expect(planNumberedTerminalInteractionResponse(request!, {
      kind: 'question',
      requestId: 'receipt-1',
      outcome: 'answered',
      answers: [{ questionId: 'question-1', optionId: 'option-2' }]
    })).toEqual({ data: '2' })
  })

  it('does not claim unsupported multi-question or multi-select interactions', () => {
    for (const toolInput of [
      {
        questions: [
          { question: 'First?', options: ['A'] },
          { question: 'Second?', options: ['B'] }
        ]
      },
      { question: 'Choose?', multiSelect: true, options: ['A', 'B'] }
    ]) {
      expect(normalizeTerminalInteraction({
        receiptId: 'receipt-unsupported',
        agentSessionId: 'agent-1',
        runId: 'run-1',
        providerId: 'codex',
        eventName: 'PreToolUse',
        payload: { tool_name: 'request_user_input', tool_input: toolInput }
      }, 100, protocol)).toBeUndefined()
    }
  })

  it('does not turn a matching tool name from a non-request Hook into another question', () => {
    expect(normalizeTerminalInteraction({
      receiptId: 'receipt-after-tool',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'codex',
      eventName: 'PostToolUse',
      payload: {
        tool_name: 'request_user_input',
        tool_input: { question: 'Already answered?', options: ['Yes', 'No'] }
      }
    }, 100, protocol)).toBeUndefined()
  })

  it('lets a Provider identify a question tool inside its permission event', () => {
    const request = normalizeTerminalInteraction({
      receiptId: 'claude-question',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'claude',
      eventName: 'PermissionRequest',
      payload: {
        tool_name: 'AskUserQuestion',
        tool_input: { question: 'Choose scope?', options: ['Focused', 'Full'] }
      }
    }, 100, {
      questionEvents: ['PermissionRequest', 'PreToolUse'],
      questionTools: ['askuserquestion']
    })

    expect(request).toMatchObject({
      kind: 'question',
      questions: [{ prompt: 'Choose scope?', options: [{ label: 'Focused' }, { label: 'Full' }] }]
    })
  })

  it('validates semantic permission choices before a Provider maps them to terminal bytes', () => {
    const request = normalizeTerminalInteraction({
      receiptId: 'permission-1',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'claude',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }
    }, 100, protocol)!

    const response = {
      kind: 'permission' as const,
      requestId: 'permission-1',
      decision: { outcome: 'selected' as const, optionId: 'allow-once' }
    }
    expect(normalizeAgentInteractionResponse(request, response)).toEqual(response)
    expect(planNumberedTerminalInteractionResponse(request, response)).toEqual({ data: '1' })
    expect(() => planNumberedTerminalInteractionResponse(request, {
      ...response,
      decision: { outcome: 'selected', optionId: 'invented' }
    })).toThrow('unknown option')
    expect(() => normalizeAgentInteractionResponse(request, {
      ...response,
      decision: { outcome: 'invented', optionId: 'allow-once' }
    } as never)).toThrow('outcome is invalid')
  })

  it('rejects ambiguous request identifiers before mapping a response', () => {
    const permission = normalizeTerminalInteraction({
      receiptId: 'permission-ambiguous',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'claude',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Bash' }
    }, 100, protocol)!
    permission.kind === 'permission' && permission.options.push({ ...permission.options[0]! })
    expect(() => normalizeAgentInteractionResponse(permission, {
      kind: 'permission',
      requestId: permission.id,
      decision: { outcome: 'selected', optionId: 'allow-once' }
    })).toThrow('duplicate option identifiers')

    const question = normalizeTerminalInteraction({
      receiptId: 'question-ambiguous',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'codex',
      eventName: 'PreToolUse',
      payload: {
        tool_name: 'request_user_input',
        tool_input: { question: 'Choose?', options: ['A', 'B'] }
      }
    }, 100, protocol)!
    if (question.kind === 'question') {
      question.questions[0]!.options.push({ ...question.questions[0]!.options[0]! })
    }
    expect(() => normalizeAgentInteractionResponse(question, {
      kind: 'question',
      requestId: question.id,
      outcome: 'answered',
      answers: [{ questionId: 'question-1', optionId: 'option-1' }]
    })).toThrow('duplicate option identifiers')
  })
})
