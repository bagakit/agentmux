import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentApprovalCard,
  AgentInteractiveCard,
  AgentQuestionCard,
  parseApprovalFromStatus,
  parseAskFromStatus,
  parseInteractivePrompt
} from '../src/renderer/src/components/AgentInteractiveCard.js'

describe('AgentInteractiveCard', () => {
  it('parses approval JSON payload from status detail', () => {
    const raw = JSON.stringify({
      approval: {
        tool: 'Bash',
        summary: 'Run rm -rf ./tmp'
      }
    })
    const parsed = parseApprovalFromStatus(raw)
    expect(parsed).toEqual({
      title: 'Allow Bash?',
      detail: 'Run rm -rf ./tmp',
      options: [
        { label: 'Allow', send: '1' },
        { label: 'Deny', send: '\u001b' }
      ]
    })
  })

  it('parses question JSON payload from status detail', () => {
    const raw = JSON.stringify({
      questions: [
        {
          question: 'Which framework do you prefer?',
          header: 'Framework Selection',
          options: ['React', 'Vue', 'Svelte']
        }
      ]
    })
    const parsed = parseAskFromStatus(raw)
    expect(parsed).toEqual({
      questions: [
        {
          question: 'Which framework do you prefer?',
          header: 'Framework Selection',
          multiSelect: false,
          options: [{ label: 'React' }, { label: 'Vue' }, { label: 'Svelte' }]
        }
      ]
    })
  })

  it('renders approval card with Allow and Deny buttons', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentApprovalCard, {
        approval: {
          title: 'Allow File Edit?',
          detail: 'Edit src/app.ts',
          options: [
            { label: 'Allow', send: '1' },
            { label: 'Deny', send: '\u001b' }
          ]
        },
        onChoose: vi.fn()
      })
    )

    expect(markup).toContain('data-agent-interactive-card="approval"')
    expect(markup).toContain('Allow File Edit?')
    expect(markup).toContain('Edit src/app.ts')
    expect(markup).toContain('Allow')
    expect(markup).toContain('Deny')
  })

  it('renders question card with options and custom text input', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentQuestionCard, {
        prompt: {
          questions: [
            {
              question: 'Choose target environment',
              header: 'Environment',
              multiSelect: false,
              options: [
                { label: 'Production', description: 'Live deployment' },
                { label: 'Staging', description: 'Test environment' }
              ]
            }
          ]
        },
        onAnswer: vi.fn(),
        onCancel: vi.fn()
      })
    )

    expect(markup).toContain('data-agent-interactive-card="question"')
    expect(markup).toContain('Environment')
    expect(markup).toContain('Choose target environment')
    expect(markup).toContain('Production')
    expect(markup).toContain('Live deployment')
    expect(markup).toContain('Staging')
    expect(markup).toContain('Test environment')
    expect(markup).toContain('Submit')
  })

  it('renders AgentInteractiveCard correctly when given JSON string', () => {
    const approvalJson = JSON.stringify({
      approval: { tool: 'WriteFile', summary: 'Overwrite package.json' }
    })
    const markup = renderToStaticMarkup(
      createElement(AgentInteractiveCard, {
        interactivePrompt: approvalJson,
        onSend: vi.fn(),
        onInterrupt: vi.fn()
      })
    )

    expect(markup).toContain('data-agent-interactive-card="approval"')
    expect(markup).toContain('Allow WriteFile?')
    expect(markup).toContain('Overwrite package.json')
  })
})
