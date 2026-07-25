import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusDot } from '../src/renderer/src/components/StatusDot.js'

const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

// Isolate one CSS rule body by its selector text so an assertion is about that rule, not an
// accidental match elsewhere in the sheet.
function ruleBody(selector: string): string {
  const at = styles.indexOf(selector)
  if (at === -1) return ''
  const open = styles.indexOf('{', at)
  const close = styles.indexOf('}', open)
  return styles.slice(open + 1, close)
}

describe('needs-you shape glyph', () => {
  it('renders the shared status vocabulary so the glyph CSS reaches StatusDot', () => {
    // StatusDot is the seam: it emits .status--{state} > .status__dot, and the status bar's
    // StatusCount emits the same classes. A glyph hung on that class therefore lifts every surface
    // that echoes status, without a second rendering path.
    const waiting = renderToStaticMarkup(
      createElement(StatusDot, { status: { state: 'waiting', source: 'native-hook', observedAt: 1 } })
    )
    expect(waiting).toContain('status status--waiting')
    expect(waiting).toContain('status__dot')
  })

  it('gives needs-you a "?" shape, not colour alone, on BOTH waiting and blocked', () => {
    // The whole point: an amber pip can be mistaken for other amber; a shape survives a glance and
    // colour-blindness. waiting and blocked are one "an agent needs you" class, so both carry it.
    const glyph = ruleBody('.status--waiting .status__dot::after, .status--blocked .status__dot::after')
    expect(glyph).toContain('content: "?"')
  })

  it('splits disconnected off amber so a dropped link can never read as needs-you', () => {
    // Before, disconnected shared the amber fill with waiting/blocked — two unrelated meanings on one
    // colour. Disconnected is now a neutral hollow ring; only needs-you owns amber.
    const disconnected = ruleBody('.status--disconnected .status__dot')
    expect(disconnected).not.toContain('--amber')
    expect(disconnected).toContain('transparent')
    // And only the needs-you states keep the amber fill.
    const needsYou = ruleBody('.status--waiting .status__dot, .status--blocked .status__dot')
    expect(needsYou).toContain('var(--amber)')
  })

  it('suppresses the glyph on the 5px corner marks where it cannot seat', () => {
    // Tab-corner and rail-row marks shrink the dot to 5px; a glyph there would be illegible, and the
    // corner position already differentiates. The pip lifts only on full-size surfaces.
    const suppressed = ruleBody(
      '.workspace-agent-row__mark .status__dot::after,\n.workbench-tab__agent-mark .status__dot::after'
    )
    expect(suppressed).toContain('display: none')
  })
})
