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
    // 行内等待用全 App 唯一那条通用 spinner。此前这里钉的是 `wf-spin`——第二条逐字节相同的
    // 旋转 keyframes，2026-09-25 并回 `.spin`（判据见 loading-vocabulary-has-two-tiers.test.ts）。
    // 用词法边界：`spin` 是个短词，`semantic-icon--spinner` 之类不该算命中。
    expect(running).toMatch(/class="[^"]*\bspin\b/u)
    expect(failed).not.toMatch(/class="[^"]*\bspin\b/u)
  })

  it('keeps every semantic meaning on a distinct default renderer', () => {
    expect(SEMANTIC_ICON_NAMES.length).toBeGreaterThan(0)
    const renderers = SEMANTIC_ICON_NAMES.map((name) => defaultSemanticIconTheme[name])
    expect(new Set(renderers).size).toBe(renderers.length)
  })

  it('allows a plugin theme to replace a semantic renderer without changing the call site', () => {
    const theme = createSemanticIconTheme({ workflow: Circle })
    const markup = renderToStaticMarkup(
      createElement(SemanticIconProvider, { theme, children: createElement(SemanticIcon, { name: 'workflow' }) })
    )
    expect(markup).toContain('semantic-icon')
    expect(markup).toContain('circle')
  })
})
