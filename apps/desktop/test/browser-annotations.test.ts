import { describe, expect, it } from 'vitest'
import type { BrowserElementSelection } from '../src/shared/contracts.js'
import {
  BROWSER_ANNOTATION_NOTE_MAX_LENGTH,
  BROWSER_CONTEXT_MAX_LENGTH,
  browserAnnotationDisplayNumber,
  browserAnnotationMarkers,
  formatBrowserAnnotationsContext,
  formatBrowserElementContext,
  normalizeBrowserAnnotationNote,
  type BrowserAnnotation
} from '../src/renderer/src/lib/browser-annotations.js'

const selection: BrowserElementSelection = {
  browserId: 'browser-1',
  navigationId: 'navigation-1',
  pageTitle: 'Example docs',
  pageUrl: 'https://example.com/docs',
  tagName: 'button',
  role: 'button',
  accessibleName: 'Open settings',
  selector: 'main > button.settings',
  text: 'Settings',
  nearbyText: ['Account'],
  attributes: { 'aria-label': 'Open settings' },
  html: '<button aria-label="Open settings">Settings</button>',
  rectViewport: { x: 1, y: 2, width: 30, height: 40 },
  rectPage: { x: 5, y: 6, width: 30, height: 40 },
  isFixed: false
}

function annotation(id: string): BrowserAnnotation {
  return {
    id,
    workspaceId: 'workspace-1',
    browserId: selection.browserId,
    navigationId: selection.navigationId,
    selection,
    note: 'Explain this control'
  }
}

describe('Browser annotation drafts', () => {
  it('formats only the sanitized selection contract for Composer handoff', () => {
    const context = formatBrowserElementContext(selection, 'Explain this control')
    for (const expected of [
      '--- amux : Browser ---',
      'Page: Example docs',
      'URL: https://example.com/docs',
      'Selector: main > button.settings',
      'Annotation: Explain this control'
    ]) expect(context).toContain(expected)
    expect(formatBrowserAnnotationsContext([annotation('one'), annotation('two')]))
      .toContain('## Element 2')
  })

  it('keeps one complete frame within the total cap for individual and aggregated context', () => {
    const large = { ...selection, text: 'x'.repeat(BROWSER_CONTEXT_MAX_LENGTH), html: 'y'.repeat(BROWSER_CONTEXT_MAX_LENGTH) }
    const contexts = [formatBrowserElementContext(large), formatBrowserAnnotationsContext(
      Array.from({ length: 30 }, (_, index) => ({ ...annotation(String(index)), selection: large }))
    )]
    for (const context of contexts) {
      expect(context.length).toBeLessThanOrEqual(BROWSER_CONTEXT_MAX_LENGTH)
      expect(context.startsWith('--- amux : Browser ---\n')).toBe(true)
      expect(context.endsWith('\n-----')).toBe(true)
      expect(context.match(/--- amux : Browser ---/gu)).toHaveLength(1)
      expect(context).toContain('URL: https://example.com/docs')
    }
  })

  it('normalizes and bounds user notes' , () => {
    expect(normalizeBrowserAnnotationNote('  explain\n\tthis  ')).toBe('explain this')
    expect(normalizeBrowserAnnotationNote('x'.repeat(BROWSER_ANNOTATION_NOTE_MAX_LENGTH + 10)))
      .toHaveLength(BROWSER_ANNOTATION_NOTE_MAX_LENGTH)
  })

  it('projects numbered marker geometry without Browser content', () => {
    expect(browserAnnotationMarkers([annotation('one')])).toEqual([{
      id: 'one',
      index: 0,
      rectViewport: selection.rectViewport,
      rectPage: selection.rectPage,
      isFixed: false
    }])
  })

  it('uses the page-overlay number across Tools and Composer projections', () => {
    const annotations = [
      annotation('one'),
      {
        ...annotation('other-browser'),
        browserId: 'browser-2',
        selection: { ...selection, browserId: 'browser-2' }
      },
      annotation('two'),
      {
        ...annotation('other-navigation'),
        navigationId: 'navigation-2',
        selection: { ...selection, navigationId: 'navigation-2' }
      }
    ]

    expect(annotations.map((_annotation, index) => browserAnnotationDisplayNumber(annotations, index)))
      .toEqual([1, 1, 2, 1])
    expect(formatBrowserAnnotationsContext(annotations).match(/^## Element \d+$/gm))
      .toEqual(['## Element 1', '## Element 1', '## Element 2', '## Element 1'])
  })
})
