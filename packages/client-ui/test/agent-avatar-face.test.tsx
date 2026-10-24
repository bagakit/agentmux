// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentAvatarFace } from '../src/components/AgentAvatarFace.js'
import { PRESENCE_MARK_CORNERS } from '../src/lib/presence-mark-corner.js'

function render(props: Parameters<typeof AgentAvatarFace>[0] = {}) {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(createElement(AgentAvatarFace, props))
  return container
}

describe('the shared read-only Agent face', () => {
  it('keeps the original compact slot, Provider artwork and badge for both brands', () => {
    for (const providerId of ['codex', 'claude']) {
      const container = render({ providerId, appearance: { badge: 'shield', tint: '#9e7df1' } })
      expect(container.querySelector<HTMLElement>('.agent-avatar__contour')?.style.getPropertyValue('--agent-avatar-size')).toBe('18px')
      const provider = container.querySelector(`[data-agent-provider="${providerId}"]`)
      expect(provider).not.toBeNull()
      expect(provider?.querySelector('svg')?.getAttribute('width')).toBe('14')
      expect(provider?.querySelector('path')?.getAttribute('d')).toBeTruthy()
      expect(container.querySelector('[data-avatar-badge="shield"]')?.getAttribute('data-corner')).toBe(PRESENCE_MARK_CORNERS.badge)
      expect(container.querySelector('feFlood[result="rimColor"]')?.getAttribute('flood-color')).toBe('#9e7df1')
      expect(container.querySelector('button,[role="status"],.agent-avatar__status')).toBeNull()
    }
  })

  it('gives repeated occurrences their own filter and preserves the original combined artwork', () => {
    const container = document.createElement('div')
    const props = { providerId: 'codex', appearance: { tint: '#8ab4f8', badge: 'spark' as const } }
    container.innerHTML = renderToStaticMarkup(createElement('div', null,
      createElement(AgentAvatarFace, props), createElement(AgentAvatarFace, props)))
    const filters = [...container.querySelectorAll('filter')]
    expect(filters).toHaveLength(2)
    expect(new Set(filters.map(filter => filter.id)).size).toBe(2)
    const marks = [...container.querySelectorAll<HTMLElement>('.agent-avatar__mark')]
    expect(marks).toHaveLength(2)
    for (const [index, mark] of marks.entries()) {
      expect(mark.style.filter).toBe(`url(#${filters[index]!.id})`)
      expect(mark.querySelector('[data-agent-provider="codex"]')).not.toBeNull()
      expect(mark.querySelector('[data-avatar-badge="spark"]')).not.toBeNull()
    }
  })

  it('retains host-resolved identity marks and the original tintMark opt-out', () => {
    const container = render({ appearance: { tint: '#8ab4f8', badge: 'bolt' },
      mark: createElement('span', { 'data-original-identity': true }, 'Mote'), tintMark: false, size: 24 })
    expect(container.querySelector('[data-original-identity]')?.textContent).toBe('Mote')
    expect(container.querySelector('[data-agent-provider],filter')).toBeNull()
    expect(container.querySelector('[data-avatar-badge="bolt"]')).not.toBeNull()
    expect(container.querySelector<HTMLElement>('.agent-avatar__contour')?.style.getPropertyValue('--agent-avatar-size')).toBe('24px')
  })

  it('keeps an unknown catalog badge from changing the original Provider identity', () => {
    const container = render({ providerId: 'claude', appearance: { badge: 'unrecorded-decoration' } })
    expect(container.querySelector('[data-agent-provider="claude"]')).not.toBeNull()
    expect(container.querySelector('[data-avatar-badge]')).toBeNull()
  })
})
