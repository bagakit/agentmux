import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'

const SOURCE = readFileSync(
  new URL('../src/renderer/src/components/AgentEnamelFilter.tsx', import.meta.url),
  'utf8'
)

function tintedAvatarMarkup(): string {
  return renderToStaticMarkup(createElement(AgentAvatar, {
    label: 'Executor',
    providerId: 'opencode',
    state: 'running',
    appearance: { tint: '#8ab4f8' }
  }))
}

describe('AgentAvatar executor tint contour', () => {
  it('uses a closed enamel backing and a crisp one-pixel outside rim', () => {
    const markup = tintedAvatarMarkup()
    expect(markup).toContain('agent-avatar__filters')
    expect(markup).toContain('agent-provider-icon')
    expect(markup).toContain('operator="dilate"')
    expect(markup).toContain('radius="2"')
    expect(markup).toContain('radius="3"')
    expect(markup).toContain('result="solidAlpha"')
    expect(markup).toContain('result="backingAlpha"')
    expect(markup).toContain('result="rimAlpha"')
    expect(markup).toContain('operator="out"')
    expect(markup).toContain('result="enamelBacking"')
    expect(markup).toContain('result="enamelRim"')
    expect(markup).toContain('flood-opacity="1"')
  })

  it('keeps tint behind SourceGraphic instead of flooding the source image', () => {
    const filterStart = SOURCE.indexOf('<filter id={id}')
    const filterEnd = SOURCE.indexOf('</filter>', filterStart)
    expect(filterStart).toBeGreaterThan(-1)
    expect(filterEnd).toBeGreaterThan(filterStart)
    const filter = SOURCE.slice(filterStart, filterEnd)
    expect(filter).toContain('in="SourceAlpha" operator="dilate" radius="4" result="solidDilated"')
    expect(filter).toContain('in="solidDilated" operator="erode" radius="4" result="solidAlpha"')
    expect(filter).toContain('in="solidAlpha" operator="dilate" radius="2" result="backingAlpha"')
    expect(filter).toContain('in="solidAlpha" operator="dilate" radius="3" result="rimOuterAlpha"')
    expect(filter).toContain('in="rimOuterAlpha" in2="backingAlpha" operator="out"')
    expect(filter).toContain('floodColor="var(--surface-0)" floodOpacity="1"')
    expect(filter).toContain('in="SourceGraphic" in2="enamelSurface" operator="over"')
    expect(filter).not.toContain('in2="SourceAlpha" operator="in" />')
    expect(filter).not.toContain('floodOpacity="0.55"')
  })
})
