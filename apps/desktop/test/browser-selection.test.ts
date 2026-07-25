import { describe, expect, it } from 'vitest'
import {
  BROWSER_SELECTION_LIMITS,
  sanitizeBrowserElementSelection
} from '../src/main/browser-selection.js'

function rawSelection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageTitle: 'Example page',
    pageUrl: 'https://user:password@example.com/docs?token=secret#private',
    tagName: 'button',
    role: 'button',
    accessibleName: 'Open documentation',
    selector: 'main > button.docs',
    text: 'Open documentation',
    attributes: {
      class: 'docs primary',
      'aria-label': 'Open documentation'
    },
    nearbyText: ['Documentation', 'Learn how to use AgentMux'],
    html: '<button class="docs primary" aria-label="Open documentation">Open documentation</button>',
    rectViewport: { x: 10, y: 20, width: 180, height: 32 },
    rectPage: { x: 10, y: 220, width: 180, height: 32 },
    isFixed: false,
    ...overrides
  }
}

describe('Main-owned Browser selection sanitizer', () => {
  it('produces a bounded typed selection and removes URL secrets', () => {
    expect(sanitizeBrowserElementSelection(rawSelection())).toEqual({
      pageTitle: 'Example page',
      pageUrl: 'https://example.com/docs',
      tagName: 'button',
      role: 'button',
      accessibleName: 'Open documentation',
      selector: 'main > button.docs',
      text: 'Open documentation',
      attributes: {
        'aria-label': 'Open documentation',
        class: 'docs primary'
      },
      nearbyText: ['Documentation', 'Learn how to use AgentMux'],
      html: '<button aria-label="Open documentation" class="docs primary">Open documentation</button>',
      rectViewport: { x: 10, y: 20, width: 180, height: 32 },
      rectPage: { x: 10, y: 220, width: 180, height: 32 },
      isFixed: false
    })
  })

  it('rebuilds hostile HTML from an allowlist instead of preserving active markup', () => {
    const html = sanitizeBrowserElementSelection(rawSelection({ html: [
      '<div onclick="steal()" style="position:fixed" data-access-token="secret">',
      '<script><img src="https://tracker.test/pixel?secret=1"></script>',
      '<script/><img src="https://tracker.test/self-closing-confusion"></script>',
      '<svg><a href="https://tracker.test/from-svg">hidden</a></svg>',
      '<a href="javascript:alert(1)" nonce="secret" integrity="hash">unsafe</a>',
      '<a href="/relative/path">relative</a>',
      '<a href="https://example.com/path?token=secret#fragment" title="A &quot;link&quot;">safe & text</a>',
      '<img src="http://images.example.test/image.png?signature=secret#fragment" srcdoc="<script>bad()</script>">',
      '</div>'
    ].join('') })).html

    expect(html).toBe(
      '<div><a>unsafe</a><a>relative</a><a href="https://example.com/path" title="A &amp;quot;link&amp;quot;">' +
      'safe &amp; text</a><img src="http://images.example.test/image.png"></div>'
    )
    expect(html).not.toMatch(/script|svg|onclick|style=|token|nonce|integrity|srcdoc|javascript/i)
  })

  it('drops unsafe raw attributes and canonicalizes safe URL attributes', () => {
    const sanitized = sanitizeBrowserElementSelection(rawSelection({
      attributes: {
        onfocus: 'steal()',
        style: 'display:none',
        srcdoc: '<script>steal()</script>',
        nonce: 'secret',
        integrity: 'secret',
        value: 'password',
        'data-api-token': 'secret',
        href: 'javascript:alert(1)',
        src: 'https://cdn.example.test/image.png?signature=secret#private',
        title: 'Safe'
      }
    }))

    expect(sanitized.attributes).toEqual({
      src: 'https://cdn.example.test/image.png',
      title: 'Safe'
    })
  })

  it('enforces string, array, HTML, and geometry budgets', () => {
    const attributes = Object.fromEntries([
      'title', 'class', 'id', 'lang', 'dir', 'role', 'tabindex', 'alt', 'placeholder',
      'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-details', 'aria-current',
      'aria-expanded', 'aria-selected', 'aria-checked', 'aria-disabled', 'aria-hidden',
      'aria-level', 'aria-live', 'aria-pressed', 'aria-readonly', 'aria-required',
      'aria-roledescription', 'aria-valuetext'
    ].map((name) => [name, 'v'.repeat(BROWSER_SELECTION_LIMITS.attributeValue + 50)]))
    const sanitized = sanitizeBrowserElementSelection(rawSelection({
      pageTitle: 'p'.repeat(BROWSER_SELECTION_LIMITS.pageTitle + 10),
      role: 'r'.repeat(BROWSER_SELECTION_LIMITS.role + 10),
      accessibleName: 'a'.repeat(BROWSER_SELECTION_LIMITS.accessibleName + 10),
      selector: 's'.repeat(BROWSER_SELECTION_LIMITS.selector + 10),
      text: 't'.repeat(BROWSER_SELECTION_LIMITS.text + 10),
      attributes,
      nearbyText: Array.from(
        { length: BROWSER_SELECTION_LIMITS.nearbyTextItems + 10 },
        (_, index) => `${index}-${'n'.repeat(BROWSER_SELECTION_LIMITS.nearbyTextItem + 20)}`
      ),
      html: `<div>${'&'.repeat(BROWSER_SELECTION_LIMITS.htmlInput + 100)}</div>`,
      rectViewport: { x: -2_000_000, y: 2_000_000, width: -10, height: 2_000_000 }
    }))

    expect(sanitized.pageTitle).toHaveLength(BROWSER_SELECTION_LIMITS.pageTitle)
    expect(sanitized.role).toHaveLength(BROWSER_SELECTION_LIMITS.role)
    expect(sanitized.accessibleName).toHaveLength(BROWSER_SELECTION_LIMITS.accessibleName)
    expect(sanitized.selector).toHaveLength(BROWSER_SELECTION_LIMITS.selector)
    expect(sanitized.text).toHaveLength(BROWSER_SELECTION_LIMITS.text)
    expect(Object.keys(sanitized.attributes)).toHaveLength(BROWSER_SELECTION_LIMITS.attributes)
    expect(Object.values(sanitized.attributes).every(
      (value) => value.length === BROWSER_SELECTION_LIMITS.attributeValue
    )).toBe(true)
    expect(sanitized.nearbyText.length).toBeLessThanOrEqual(BROWSER_SELECTION_LIMITS.nearbyTextItems)
    expect(sanitized.nearbyText.join('').length).toBeLessThanOrEqual(BROWSER_SELECTION_LIMITS.nearbyTextTotal)
    expect(sanitized.html.length).toBeLessThanOrEqual(BROWSER_SELECTION_LIMITS.htmlOutput)
  })

  it('clamps finite geometry values without inventing coordinates', () => {
    expect(sanitizeBrowserElementSelection(rawSelection({
      rectViewport: { x: -2_000_000, y: 2_000_000, width: -10, height: 2_000_000 }
    })).rectViewport).toEqual({
      x: -BROWSER_SELECTION_LIMITS.coordinate,
      y: BROWSER_SELECTION_LIMITS.coordinate,
      width: 0,
      height: BROWSER_SELECTION_LIMITS.size
    })
  })

  it.each([
    null,
    [],
    rawSelection({ pageUrl: 'file:///tmp/private' }),
    rawSelection({ selector: 42 }),
    rawSelection({ nearbyText: ['valid', 42] }),
    rawSelection({ attributes: { title: 42 } }),
    rawSelection({ attributes: new Date() }),
    rawSelection({ rectViewport: { x: Number.NaN, y: 0, width: 1, height: 1 } }),
    rawSelection({ isFixed: 'false' }),
    { ...rawSelection(), unexpected: true }
  ])('rejects invalid or ambiguous raw input %#', (input) => {
    expect(() => sanitizeBrowserElementSelection(input)).toThrow()
  })

  it('is deterministic and canonicalizes attribute order', () => {
    const input = rawSelection({
      attributes: {
        TITLE: 'same',
        'aria-label': 'label',
        title: 'ignored duplicate'
      },
      html: '<p title="same" aria-label="label">text</p>'
    })
    const first = sanitizeBrowserElementSelection(input)
    const second = sanitizeBrowserElementSelection(structuredClone(input))

    expect(first).toEqual(second)
    expect(first.attributes).toEqual({
      'aria-label': 'label',
      title: 'same'
    })
    expect(first.html).toBe('<p aria-label="label" title="same">text</p>')
  })

  it('removes invisible direction controls from text-bearing fields', () => {
    const sanitized = sanitizeBrowserElementSelection(rawSelection({
      pageTitle: 'safe\u202eevil',
      selector: 'button\u200b.primary',
      nearbyText: ['before\u2066hidden\u2069after']
    }))

    expect(sanitized.pageTitle).toBe('safe evil')
    expect(sanitized.selector).toBe('button.primary')
    expect(sanitized.nearbyText).toEqual(['before hidden after'])
  })
})
