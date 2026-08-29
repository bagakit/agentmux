import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusDot } from '../src/renderer/src/components/StatusDot.js'
import { allStyles } from './helpers/styles.js'

const styles = allStyles()

// Isolate one CSS rule body by its selector text so an assertion is about that rule, not an
// accidental match elsewhere in the sheet.
//
// 找不到就**当场报红**，不返回空串。空串会让每一条 `toContain` 变成同一句「没找到」，而让每一条
// `not.toContain` 恒真——本仓已经记过这个形状（indexOf 取锚点取空）。这次它真的咬了人：
// `bcd94ac3` 删掉 5px 标记的抑制规则后，这里读到的是空串，报错写着「expected '' to contain
// 'display: none'」，看上去像规则体不对，实际是规则整条不在了。
function ruleBody(selector: string): string {
  const at = styles.indexOf(selector)
  expect(at, `样式表里找不到这条选择器，它被删掉或改名了：${selector}`).toBeGreaterThan(-1)
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
    // And only the needs-you states own amber. The colour itself now lives on the state class as
    // --status-ink (one definition feeding dot fill and avatar border alike), so that is where the
    // ownership is asserted; the dot rule below it only shapes the pip.
    expect(ruleBody('.status--waiting, .status--blocked')).toContain('var(--amber)')
    expect(ruleBody('.status--disconnected {')).not.toContain('var(--amber)')
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
