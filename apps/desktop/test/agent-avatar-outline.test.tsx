import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'

const SOURCE = readFileSync(
  new URL('../src/renderer/src/components/AgentAvatar.tsx', import.meta.url),
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
  it('uses a 1px expanded alpha silhouette outside the original mark', () => {
    const markup = tintedAvatarMarkup()
    expect(markup).toContain('agent-avatar__filters')
    expect(markup).toContain('agent-provider-icon')
    expect(markup).toContain('operator="dilate"')
    expect(markup).toContain('radius="1"')
    expect(markup).toContain('result="solidAlpha"')
    expect(markup).toContain('result="outerAlpha"')
    expect(markup).toContain('operator="out"')
    expect(markup).toContain('result="tintOutline"')
  })

  it('keeps tint behind SourceGraphic instead of flooding the source image', () => {
    const filterStart = SOURCE.indexOf('<filter id={filterId}')
    const filterEnd = SOURCE.indexOf('</filter>', filterStart)
    expect(filterStart).toBeGreaterThan(-1)
    expect(filterEnd).toBeGreaterThan(filterStart)
    const filter = SOURCE.slice(filterStart, filterEnd)
    expect(filter).toContain('in="SourceAlpha" operator="dilate" radius="4" result="solidDilated"')
    expect(filter).toContain('in="solidDilated" operator="erode" radius="4" result="solidAlpha"')
    expect(filter).toContain('in="solidAlpha" operator="dilate" radius="1" result="expandedAlpha"')
    expect(filter).toContain('in="expandedAlpha" in2="solidAlpha" operator="out"')
    expect(filter).toContain('in="SourceGraphic" in2="tintOutline" operator="over"')
    expect(filter).not.toContain('in2="SourceAlpha" operator="in" />')
    expect(filter).not.toContain('in2="SourceGraphic" operator="over" />')
  })
})
