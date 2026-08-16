import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createSemanticIconTheme, defaultSemanticIconTheme, SEMANTIC_ICON_NAMES, SemanticIcon, SemanticIconProvider, WorkflowSemanticIcon } from '../src/renderer/src/components/semantic-icons'
import { Circle } from 'lucide-react'

describe('semantic icon contract', () => {
  it('keeps the semantic vocabulary non-empty and renders dynamic states through one path', () => {
    const running = renderToStaticMarkup(createElement(WorkflowSemanticIcon, { status: 'running' }))
    const failed = renderToStaticMarkup(createElement(WorkflowSemanticIcon, { status: 'failed' }))
    expect(running).toContain('semantic-icon')
    expect(failed).toContain('semantic-icon')
    expect(running).toContain('wf-spin')
    expect(failed).not.toContain('wf-spin')
  })

  it('keeps every semantic meaning on a distinct default renderer', () => {
    expect(SEMANTIC_ICON_NAMES.length).toBeGreaterThan(0)
    const renderers = SEMANTIC_ICON_NAMES.map((name) => defaultSemanticIconTheme[name])
    expect(new Set(renderers).size).toBe(renderers.length)
  })

  it('allows a plugin theme to replace a semantic renderer without changing the call site', () => {
    const theme = createSemanticIconTheme({ workflow: Circle })
    const markup = renderToStaticMarkup(
      createElement(SemanticIconProvider, { theme }, createElement(SemanticIcon, { name: 'workflow' }))
    )
    expect(markup).toContain('semantic-icon')
    expect(markup).toContain('circle')
  })
})
