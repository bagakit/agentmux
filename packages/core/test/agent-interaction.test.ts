import { describe, expect, it } from 'vitest'
import {
  createNumberedTerminalInteractionProtocol,
  createPostureControl,
  normalizeAgentInteractionResponse,
  normalizeTerminalInteraction,
  validatePermissionOptions,
  validatePostureControl,
  type PostureControlDeclaration,
  type TerminalPermissionOption
} from '../src/agent-interaction.js'

const ESC = ''

// A two-option (Codex-shaped) declaration and a three-option (Claude-shaped) declaration, so the tests
// exercise both the single-allow compact case and the scoped allow-once + allow-always case.
const CODEX_OPTIONS: readonly TerminalPermissionOption[] = [
  { id: 'allow-once', label: 'Allow', kind: 'allow-once', tier: 'safe', input: '1' },
  { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe', input: ESC }
]
const CLAUDE_OPTIONS: readonly TerminalPermissionOption[] = [
  { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe', input: '1' },
  {
    id: 'allow-always',
    label: "Allow & don't ask again",
    description: 'This tool, this directory.',
    kind: 'allow-always',
    tier: 'caution',
    input: '2'
  },
  { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe', input: ESC }
]

const codexProtocol = createNumberedTerminalInteractionProtocol({
  questionEvents: ['PreToolUse'],
  questionTools: ['request_user_input', 'askuserquestion'],
  permissionOptions: CODEX_OPTIONS
})
const claudeProtocol = createNumberedTerminalInteractionProtocol({
  questionEvents: ['PermissionRequest', 'PreToolUse'],
  questionTools: ['askuserquestion'],
  permissionOptions: CLAUDE_OPTIONS
})

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
    }, 100, codexProtocol)

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
    expect(codexProtocol.planResponse(request!, {
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
      }, 100, codexProtocol)).toBeUndefined()
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
    }, 100, codexProtocol)).toBeUndefined()
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
    }, 100, claudeProtocol)

    expect(request).toMatchObject({
      kind: 'question',
      questions: [{ prompt: 'Choose scope?', options: [{ label: 'Focused' }, { label: 'Full' }] }]
    })
  })

  it('projects every declared scoped option and maps each to its own declared keystroke', () => {
    const request = normalizeTerminalInteraction({
      receiptId: 'permission-claude',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'claude',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Edit', tool_input: { path: 'src/index.ts' } }
    }, 100, claudeProtocol)!

    // Every declared option — including allow-always — is projected with its DESCRIBE half; the
    // keystroke (`input`) is deliberately withheld from the request that crosses IPC.
    expect(request).toMatchObject({
      kind: 'permission',
      title: 'Allow Edit?',
      options: [
        { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe' },
        {
          id: 'allow-always',
          label: "Allow & don't ask again",
          description: 'This tool, this directory.',
          kind: 'allow-always',
          tier: 'caution'
        },
        { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe' }
      ]
    })
    expect(request.kind === 'permission' && 'input' in request.options[0]!).toBe(false)

    const reply = (optionId: string) => claudeProtocol.planResponse(request, {
      kind: 'permission' as const,
      requestId: 'permission-claude',
      decision: { outcome: 'selected' as const, optionId }
    })
    expect(reply('allow-once')).toEqual({ data: '1' })
    expect(reply('allow-always')).toEqual({ data: '2' })
    expect(reply('reject-once')).toEqual({ data: ESC })
    expect(claudeProtocol.planResponse(request, {
      kind: 'permission',
      requestId: 'permission-claude',
      decision: { outcome: 'cancelled' }
    })).toEqual({ data: ESC })
  })

  it('validates the semantic choice and fails closed on an option no Provider declares', () => {
    const request = normalizeTerminalInteraction({
      receiptId: 'permission-1',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'codex',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }
    }, 100, codexProtocol)!

    const response = {
      kind: 'permission' as const,
      requestId: 'permission-1',
      decision: { outcome: 'selected' as const, optionId: 'allow-once' }
    }
    expect(normalizeAgentInteractionResponse(request, response)).toEqual(response)
    expect(codexProtocol.planResponse(request, response)).toEqual({ data: '1' })
    expect(() => codexProtocol.planResponse(request, {
      ...response,
      decision: { outcome: 'selected', optionId: 'invented' }
    })).toThrow('unknown option')
    expect(() => normalizeAgentInteractionResponse(request, {
      ...response,
      decision: { outcome: 'invented', optionId: 'allow-once' }
    } as never)).toThrow('outcome is invalid')
  })

  it('fails closed when a permission declaration is malformed', () => {
    expect(() => validatePermissionOptions([])).toThrow('at least one option')
    expect(() => validatePermissionOptions([
      { id: 'allow-once', label: 'Allow', kind: 'allow-once', input: '1' },
      { id: 'allow-once', label: 'Deny', kind: 'reject-once', input: ESC }
    ])).toThrow('Duplicate permission option id')
    expect(() => validatePermissionOptions([
      { id: 'allow-once', label: 'Allow', kind: 'allow-once', input: '' },
      { id: 'reject-once', label: 'Deny', kind: 'reject-once', input: ESC }
    ])).toThrow('non-empty id, label, and input')
    expect(() => validatePermissionOptions([
      { id: 'allow-once', label: 'Allow', kind: 'allow-once', input: '1' }
    ])).toThrow('at least one allow and one reject')
    expect(() => createNumberedTerminalInteractionProtocol({
      questionEvents: [],
      questionTools: [],
      permissionOptions: [{ id: 'reject-once', label: 'Deny', kind: 'reject-once', input: ESC }]
    })).toThrow('at least one allow and one reject')
  })

  it('rejects ambiguous request identifiers before mapping a response', () => {
    const permission = normalizeTerminalInteraction({
      receiptId: 'permission-ambiguous',
      agentSessionId: 'agent-1',
      runId: 'run-1',
      providerId: 'codex',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Bash' }
    }, 100, codexProtocol)!
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
    }, 100, codexProtocol)!
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

// A grok-shaped declaration: two addressable modes, each SET by a distinct in-band slash command.
const GROK_SHAPED: PostureControlDeclaration = {
  id: 'approval',
  label: 'Approvals',
  modes: [
    { id: 'ask', label: 'Ask each time', tier: 'safe', input: '/always-approve off\r' },
    { id: 'always-approve', label: 'Auto-approve', description: 'Skip prompts.', tier: 'danger', input: '/always-approve on\r' }
  ]
}

describe('Agent posture control', () => {
  it('projects the DESCRIBE half without any keystroke and maps a picked mode to its input', () => {
    const posture = createPostureControl(GROK_SHAPED)

    // The catalog-facing control carries labels/tiers the composer draws — and no `input`, so a keystroke
    // never crosses IPC.
    expect(posture.control).toEqual({
      id: 'approval',
      label: 'Approvals',
      modes: [
        { id: 'ask', label: 'Ask each time', tier: 'safe' },
        { id: 'always-approve', label: 'Auto-approve', description: 'Skip prompts.', tier: 'danger' }
      ]
    })
    expect(JSON.stringify(posture.control)).not.toContain('always-approve on')

    // Each mode id resolves to its own declared bytes — a SET, not a cycle.
    expect(posture.planSet('ask')).toEqual({ data: '/always-approve off\r' })
    expect(posture.planSet('always-approve')).toEqual({ data: '/always-approve on\r' })
  })

  it('fails closed on a mode the Provider does not declare', () => {
    const posture = createPostureControl(GROK_SHAPED)
    expect(() => posture.planSet('yolo')).toThrow('does not declare')
  })

  it('rejects a single-mode declaration: a blind cycle is not an addressable control', () => {
    // The heart of the honesty invariant: a Provider whose only affordance is a Shift+Tab cycle (one
    // keystroke advancing through states it cannot read) cannot be expressed as a set-mode control, because
    // a control requires at least TWO modes. So it can never be dressed up as "set mode X".
    expect(() => validatePostureControl({
      id: 'approval',
      label: 'Approvals',
      modes: [{ id: 'cycle', label: 'Cycle', input: '[Z' }]
    })).toThrow('at least two addressable modes')
  })

  it('rejects two modes that share a keystroke: an unaddressable mode is not a target', () => {
    expect(() => validatePostureControl({
      id: 'approval',
      label: 'Approvals',
      modes: [
        { id: 'ask', label: 'Ask', input: '[Z' },
        { id: 'auto', label: 'Auto', input: '[Z' }
      ]
    })).toThrow('not addressable')
  })

  it('rejects an empty keystroke, id, or label', () => {
    expect(() => validatePostureControl({
      id: 'approval',
      label: 'Approvals',
      modes: [
        { id: 'ask', label: 'Ask', input: '1' },
        { id: 'auto', label: 'Auto', input: '' }
      ]
    })).toThrow('non-empty id, label, and input')
  })
})
