import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AgentProviderIcon,
  agentProviderLabel
} from '../src/renderer/src/components/AgentProviderIcon.js'

describe('AgentProviderIcon', () => {
  it('renders a real offline identity mark for every built-in Agent', () => {
    for (const [providerId, element] of [
      ['codex', 'svg'],
      ['claude', 'svg'],
      ['traex', 'img'],
      ['hermes', 'img'],
      ['pi', 'svg']
    ] as const) {
      const markup = renderToStaticMarkup(createElement(AgentProviderIcon, { providerId, size: 16 }))
      expect(markup).toContain(`data-agent-provider="${providerId}"`)
      expect(markup).toContain('data-agent-provider-known="true"')
      expect(markup).toContain(`<${element}`)
      expect(markup).not.toContain('<text')
    }
  })

  it('keeps custom Provider identity neutral instead of impersonating a built-in Agent', () => {
    const markup = renderToStaticMarkup(createElement(AgentProviderIcon, {
      providerId: 'private-agent',
      size: 16
    }))

    expect(markup).toContain('data-agent-provider="private-agent"')
    expect(markup).toContain('data-agent-provider-known="false"')
    expect(markup).toContain('<svg')
  })

  it('uses one shared display label mapping across Agent surfaces', () => {
    expect(['codex', 'claude', 'traex', 'hermes', 'pi'].map(agentProviderLabel)).toEqual([
      'Codex',
      'Claude',
      'TraeX',
      'Hermes',
      'Pi'
    ])
    expect(agentProviderLabel('private-agent')).toBe('private-agent')
    expect(agentProviderLabel('toString')).toBe('toString')
  })
})
