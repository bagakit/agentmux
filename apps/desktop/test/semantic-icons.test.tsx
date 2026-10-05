import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { semanticIconHref, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS, iconShapes } from '@agentmux/client-ui/icons'
import { SemanticIcon, WorkflowSemanticIcon } from '../src/renderer/src/components/semantic-icons'

describe('desktop semantic adapter consumes the shared owner', () => {
  it('retains workflow spinner and static terminal states without a local theme provider', () => {
    const running = renderToStaticMarkup(createElement(WorkflowSemanticIcon, { status: 'running' }))
    const failed = renderToStaticMarkup(createElement(WorkflowSemanticIcon, { status: 'failed' }))
    expect(running).toContain(semanticIconHref('object.workflow'))
    expect(failed).toContain(semanticIconHref('status.failed'))
    expect(running).toMatch(/class="[^"]*\bspin\b/u)
    expect(failed).not.toMatch(/class="[^"]*\bspin\b/u)
  })

  it('uses a non-empty shared vocabulary with real drawable defaults', () => {
    expect(SEMANTIC_ICON_IDS.length).toBeGreaterThan(30)
    for (const name of SEMANTIC_ICON_IDS) {
      expect(SEMANTIC_ICON_CATALOG[name].label).not.toBe('')
      expect(iconShapes(name).length).toBeGreaterThan(0)
    }
  })

  it('projects a semantic meaning without embedding a second glyph mapping', () => {
    const markup = renderToStaticMarkup(createElement(SemanticIcon, { name: 'object.workflow' }))
    expect(markup).toContain('data-semantic-icon="object.workflow"')
    expect(markup).toContain(`<use href="${semanticIconHref('object.workflow')}"`)
    expect(markup).not.toContain('<path')
  })
})
