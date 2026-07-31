import { describe, expect, it } from 'vitest'
import {
  cssColorToOscRgb,
  scanTerminalOscColorQueries
} from '../src/shared/terminal-osc-color-query.js'

const colors = { foreground: '#ffffff', background: '#282c34' }

describe('Terminal OSC color query replies', () => {
  it('uses the standard 16-bit rgb reply form', () => {
    expect(cssColorToOscRgb('#282c34')).toBe('rgb:2828/2c2c/3434')
    expect(cssColorToOscRgb('rgb(40 44 52)')).toBe('rgb:2828/2c2c/3434')
  })

  it('answers foreground and background queries without touching normal output', () => {
    const result = scanTerminalOscColorQueries(
      `before\x1b]10;?\x07middle\x1b]11;?\x1b\\after`,
      '',
      colors
    )
    expect(result).toEqual({
      remainder: '',
      replies: [
        '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
        '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
      ]
    })
  })

  it('preserves a query split across CtxMux output chunks and replies once', () => {
    const first = scanTerminalOscColorQueries('prompt\x1b]10;?;', '', colors)
    expect(first).toEqual({ remainder: '\x1b]10;?;', replies: [] })

    const second = scanTerminalOscColorQueries('?\x1b\\tail', first.remainder, colors)
    expect(second).toEqual({
      remainder: '',
      replies: [
        '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
        '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
      ]
    })
  })

  it('retains a split OSC prefix but ignores color mutations and malformed queries', () => {
    expect(scanTerminalOscColorQueries('text\x1b', '', colors)).toEqual({
      remainder: '\x1b',
      replies: []
    })
    expect(scanTerminalOscColorQueries(']11;#000000\x07\x1b]11;wat\x07', '\x1b', colors)).toEqual({
      remainder: '',
      replies: []
    })
  })
})
