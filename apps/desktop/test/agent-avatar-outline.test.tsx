import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'

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
    const filter = tintedAvatarMarkup().match(/<filter\b[\s\S]*?<\/filter>/u)?.[0]
    expect(filter, 'the actual Avatar must render the shared enamel filter').toBeTruthy()
    expect(filter).toContain('in="SourceAlpha" operator="dilate" radius="4" result="solidDilated"')
    expect(filter).toContain('in="solidDilated" operator="erode" radius="4" result="solidAlpha"')
    expect(filter).toContain('in="solidAlpha" operator="dilate" radius="2" result="backingAlpha"')
    expect(filter).toContain('in="solidAlpha" operator="dilate" radius="3" result="rimOuterAlpha"')
    expect(filter).toContain('in="rimOuterAlpha" in2="backingAlpha" operator="out"')
    // Desktop re-exports the shared client-ui implementation. Assert its actual
    // rendered filter, independent of module placement or JSX token syntax.
    expect(filter).toContain('flood-color="var(--surface-0)" flood-opacity="1"')
    expect(filter).toContain('in="SourceGraphic" in2="enamelSurface" operator="over"')
    expect(filter).not.toContain('in2="SourceAlpha" operator="in"')
    expect(filter).not.toContain('flood-opacity="0.55"')
  })

  it('底衬真的取到 surface-0，而不是只在源码里长得像', () => {
    // The actual backing node must use the shared surface token.
    const markup = tintedAvatarMarkup()
    const backing = markup.match(/<feFlood[^>]*result="backingColor"[^>]*>/u)?.[0]
    expect(backing, '没有找到底衬那枚 feFlood——下面的断言会恒真').toBeTruthy()
    expect(backing).toContain('flood-color="var(--surface-0)"')
  })
})
