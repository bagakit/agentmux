import { describe, expect, it } from 'vitest'
import { terminalOptions } from '../src/renderer/src/lib/terminal-theme'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN
} from '../src/shared/contracts'

// ---------------------------------------------------------------------------
// Guard 1 — terminal-theme.ts 的字号必须**派生自 SSOT**，不能再写死一个字面量。
//
// 为什么不 grep `fontSize: 12`：那条判据被 `fontSize: 1 + 11`、`fontSize: 0xc`、`fontSize: 6 * 2`
// 轻易绕过（本仓「数符号名守不住别的拼法」一族）。真正要钉的是**派生关系**：terminalOptions 不传
// 字号时给出的，必须**恰好等于** contracts 导出的那个 SSOT 默认值——不是「等于 12」这个巧合，而是
// 「等于 SSOT 现在的值」。所以判据用导入的常量做期望，而不是硬写数字。
//
// 反证（mutation 已实测，见任务报告）：把 terminal-theme.ts 里的默认改回硬编码 `fontSize: 12`、
// 同时把 SSOT 的 DEFAULT 改成别的数，这条会红——因为 terminalOptions 仍吐 12，而期望跟着 SSOT 变了。
// 若判据是 `toBe(12)`，那次 mutation 反而全绿。
// ---------------------------------------------------------------------------

describe('terminal font size is derived from the single source of truth', () => {
  it('terminalOptions 不传字号时，用的是 SSOT 默认值（不是巧合等于某个字面量）', () => {
    expect(terminalOptions('graphite').fontSize).toBe(TERMINAL_FONT_SIZE_DEFAULT)
  })

  it('传入的字号一路透传到 xterm options（终端确实用得上这个旋钮）', () => {
    const inRange = Math.round((TERMINAL_FONT_SIZE_MIN + TERMINAL_FONT_SIZE_MAX) / 2)
    expect(terminalOptions('graphite', inRange).fontSize).toBe(inRange)
    // 与默认不同的一个值，证明第二个参数真的参与了组装，而不是恒回默认。
    expect(inRange).not.toBe(TERMINAL_FONT_SIZE_DEFAULT)
  })

  it('SSOT 的边界自洽：min < default < max，且都是整数', () => {
    for (const value of [TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX]) {
      expect(Number.isInteger(value)).toBe(true)
    }
    expect(TERMINAL_FONT_SIZE_MIN).toBeLessThan(TERMINAL_FONT_SIZE_DEFAULT)
    expect(TERMINAL_FONT_SIZE_DEFAULT).toBeLessThan(TERMINAL_FONT_SIZE_MAX)
  })
})
