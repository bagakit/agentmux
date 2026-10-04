import { describe, expect, it } from 'vitest'
import { renderDot } from '../src/renderer/src/lib/file-formats/dot-engine'

describe('real Graphviz WASM', () => {
  it('renders actual nodes/edges and reports invalid DOT without a fabricated SVG', async () => {
    const rendered = await renderDot('digraph { CurrentDraft -> Result }')
    expect(rendered.error).toBeUndefined()
    expect(rendered.svg).toContain('<svg')
    expect(rendered.svg).toContain('CurrentDraft')
    expect(rendered.svg).toContain('Result')
    expect(rendered.svg).toContain('class="edge"')
    const invalid = await renderDot('digraph { A -> }')
    expect(invalid.svg).toBe('')
    expect(invalid.error).toMatch(/syntax error/i)
  })
})
