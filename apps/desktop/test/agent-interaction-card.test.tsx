import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentInteractionCard } from '../src/renderer/src/components/AgentInteractionCard.js'

describe('AgentInteractionCard', () => {
  it('renders only Core-owned permission choices', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'permission',
        id: 'permission-1',
        agentSessionId: 'agent-1',
        title: 'Allow Bash?',
        toolName: 'Bash',
        toolInput: '{"command":"pnpm test"}',
        options: [
          { id: 'allow', label: 'Allow once', kind: 'allow-once' },
          { id: 'deny', label: 'Deny', kind: 'reject-once' }
        ],
        evidence: {
          source: 'native-hook',
          observedAt: 1,
          run: { runId: 'run-1' },
          hookReceiptId: 'permission-1'
        }
      },
      onRespond: async () => {}
    }))

    expect(markup).toContain('Allow Bash?')
    expect(markup).toContain('Allow once')
    expect(markup).toContain('Deny')
    expect(markup).toContain('pnpm test')
    // Only the affirmative option carries the solid brand fill; deny and dismiss stay secondary.
    expect(markup.match(/is-primary/gu) ?? []).toHaveLength(1)
    // Dismissing is not a verdict, so it is marked apart from the allow/deny pair.
    expect(markup).toContain('agent-interaction__dismiss')
  })

  it('disables every action when the Agent can no longer accept one', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'permission',
        id: 'permission-1',
        agentSessionId: 'agent-1',
        title: 'Allow Bash?',
        options: [
          { id: 'allow', label: 'Allow once', kind: 'allow-once' },
          { id: 'deny', label: 'Deny', kind: 'reject-once' }
        ],
        evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run-1' } }
      },
      disabled: true,
      onRespond: async () => {}
    }))

    // Allow, Deny, and the dismiss control must all go inert together — a half-live card would let
    // the user answer a Run that cannot take the answer.
    expect(markup.match(/disabled=""/gu) ?? []).toHaveLength(3)
  })

  it('renders one Core-validated single-select question', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'question',
        id: 'question-1',
        agentSessionId: 'agent-1',
        questions: [{
          id: 'scope',
          title: 'Scope',
          prompt: 'Which tests?',
          options: [
            { id: 'focused', label: 'Focused', description: 'Affected tests only' },
            { id: 'full', label: 'Full suite' }
          ]
        }],
        evidence: {
          source: 'native-hook',
          observedAt: 1,
          run: { runId: 'run-1' },
          hookReceiptId: 'question-1'
        }
      },
      onRespond: async () => {}
    }))

    expect(markup).toContain('Which tests?')
    expect(markup).toContain('Affected tests only')
    expect(markup).toContain('Full suite')
  })
})
