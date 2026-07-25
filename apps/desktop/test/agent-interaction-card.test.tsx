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

  it('lays a second allow into a scoped vertical column instead of the action row', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'permission',
        id: 'permission-scoped',
        agentSessionId: 'agent-1',
        title: 'Allow Edit?',
        toolName: 'Edit',
        options: [
          { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe' },
          {
            id: 'allow-always',
            label: "Allow & don't ask again",
            description: 'This tool, this directory.',
            kind: 'allow-always',
            tier: 'caution'
          },
          { id: 'deny', label: 'Deny', kind: 'reject-once', tier: 'safe' }
        ],
        evidence: {
          source: 'native-hook',
          observedAt: 1,
          run: { runId: 'run-1' },
          hookReceiptId: 'permission-scoped'
        }
      },
      onRespond: async () => {}
    }))

    // A second allow promotes the affirmatives into the scoped vertical list; deny stays in the row.
    expect(markup).toContain('agent-interaction__grants')
    expect(markup).toContain('Allow once')
    expect(markup).toContain('ask again')
    expect(markup).toContain('This tool, this directory.')
    // Each affirmative carries exactly one tier dot; allow-once is safe, allow-always is caution.
    expect(markup).toContain('agent-interaction__tier--safe')
    expect(markup).toContain('agent-interaction__tier--caution')
    // Even across the scoped layout, allow-once is the sole primary; allow-always and deny are not.
    expect(markup.match(/is-primary/gu) ?? []).toHaveLength(1)
    expect(markup).toContain('agent-interaction__dismiss')
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
