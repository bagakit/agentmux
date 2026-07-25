import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentInteractionCard } from '../src/renderer/src/components/AgentInteractionCard.js'

describe('AgentInteractionCard', () => {
  it('renders only Core-owned permission choices', () => {
    const respond = vi.fn()
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
      onRespond: async (response) => { respond(response) }
    }))

    expect(markup).toContain('Allow Bash?')
    expect(markup).toContain('Allow once')
    expect(markup).toContain('Deny')
    expect(markup).toContain('pnpm test')
    expect(markup).not.toContain('status.detail')
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
