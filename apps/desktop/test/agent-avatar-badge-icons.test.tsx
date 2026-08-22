import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'

const SOURCE = readFileSync(
  new URL('../src/renderer/src/components/AgentEnamelFilter.tsx', import.meta.url),
  'utf8'
)

describe('Executor avatar badge icons', () => {
  it('renders a fixed icon beside the Provider mark without badge text', () => {
    const markup = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'Executor', providerId: 'codex', state: 'running', appearance: { badge: 'shield' }
    }))
    const markStart = markup.indexOf('class="agent-avatar__mark"')
    const markEnd = markup.indexOf('</span></span>', markStart)
    expect(markStart).toBeGreaterThan(-1)
    expect(markEnd).toBeGreaterThan(markStart)
    const mark = markup.slice(markStart, markEnd)
    expect(mark).toContain('data-agent-provider="codex"')
    expect(mark).toContain('data-avatar-badge="shield"')
    expect(mark).toContain('<svg')
    expect(mark).not.toContain('>shield<')
  })

  it('overlays a compact badge inside both provider marks', () => {
    const sheets = [
      ['agent-avatar.css', '.agent-avatar__badge', 8],
      ['session-connecting.css', '.session-connecting__executor-badge', 9]
    ] as const
    for (const [file, selector, size] of sheets) {
      const css = readFileSync(new URL('../src/renderer/src/styles/' + file, import.meta.url), 'utf8')
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      expect(rules.length).toBeGreaterThan(0)
      const body = rules.find(([, head]) => head!.trim() === selector)?.[2]
      expect(body).toBeDefined()
      expect(body).toContain('width: ' + size + 'px')
      expect(body).toContain('height: ' + size + 'px')
      expect(body).toMatch(/top: [12]px/)
      expect(body).toMatch(/left: [12]px/)
    }
  })

  it('applies one combined contour source around Provider and badge', () => {
    const tinted = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'Executor', providerId: 'codex', state: 'running', appearance: { tint: '#8ab4f8', badge: 'shield' }
    }))
    expect(tinted).toContain('class="agent-avatar__mark" style="filter:url(')
    expect(tinted).toContain('data-avatar-badge="shield"')
    const filterStart = SOURCE.indexOf('<filter id={id}')
    const filterEnd = SOURCE.indexOf('</filter>', filterStart)
    expect(filterStart).toBeGreaterThan(-1)
    expect(filterEnd).toBeGreaterThan(filterStart)
    const filter = SOURCE.slice(filterStart, filterEnd)
    expect(filter).toContain('in="SourceAlpha"')
    expect(filter).toContain('result="solidAlpha"')
    expect(filter).toContain('result="backingAlpha"')
    expect(filter).toContain('result="rimAlpha"')
    expect(tinted).toContain('data-agent-provider="codex"')
    expect(tinted).toContain('data-avatar-badge="shield"')
    expect(SOURCE).not.toContain('drop-shadow(')
  })
})
