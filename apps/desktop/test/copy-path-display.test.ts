import { describe, expect, it } from 'vitest'
import { abbreviateHomePath, applyCopyPathStyle } from '../src/renderer/src/lib/copy-path-display.js'

/**
 * 复制路径的家目录缩写。设计 SSOT《寻址与复制》「复制出来的路径默认用 `~`」那几条的可执行判据：
 *   1. 缩写只在「这确实是当前用户的家目录」时发生——边界必须是 `home` 本身或 `home + '/'`，
 *      **不是** `startsWith(home)`，否则 `/Users/bytedanceOTHER/x` 会被剥成 `~OTHER/x`（点名的反例）。
 *   2. 开关（`copyPathsAsAbsolute`）能关掉缩写、给绝对路径；默认（缺席/false）缩写。
 *   3. `home` 空（渲染层还没拿到本机 home）时不缩写——宁可长，不可错。远程主机的路径由调用方
 *      负责不把本机 home 传进来，这个纯函数只管边界。
 *
 * 期望值全是写死的字面量，不由被测函数自己算（本仓 weak-assertion 陷阱）。
 */
describe('abbreviateHomePath: 缩写只按真实 home 值判边界', () => {
  const HOME = '/Users/bytedance'

  it('路径恰好是 home 本身 → ~', () => {
    expect(abbreviateHomePath('/Users/bytedance', HOME)).toBe('~')
  })

  it('home + "/" 前缀 → ~ 接其余部分（用户报的那种）', () => {
    expect(abbreviateHomePath('/Users/bytedance/proj/github/pi', HOME)).toBe('~/proj/github/pi')
  })

  it('别人的家目录不被误缩写——判据是 home 值不是路径长相（设计 SSOT 点名的反例）', () => {
    // 变异靶子 (a)：把边界写成 `startsWith(home)`，这一条立刻红——它会切成 `~OTHER/x`。
    expect(abbreviateHomePath('/Users/bytedanceOTHER/x', HOME)).toBe('/Users/bytedanceOTHER/x')
  })

  it('home 是前缀但下一段不是路径分隔 → 原样（同一反例的另一面）', () => {
    // `/Users/bytedance-backup` 以 `home` 开头，但 home 后面不是 `/`，所以不是 home 之内。
    expect(abbreviateHomePath('/Users/bytedance-backup/x', HOME)).toBe('/Users/bytedance-backup/x')
  })

  it('不在 home 之下的绝对路径 → 原样', () => {
    expect(abbreviateHomePath('/etc/hosts', HOME)).toBe('/etc/hosts')
  })

  it('home 为空（本机 home 未知）→ 一律原样，绝不拿空串去猜', () => {
    expect(abbreviateHomePath('/Users/bytedance/proj', '')).toBe('/Users/bytedance/proj')
  })
})

describe('applyCopyPathStyle: 开关与逐行缩写', () => {
  const HOME = '/Users/bytedance'

  it('默认档（copyPathsAsAbsolute 缺席）缩写', () => {
    expect(applyCopyPathStyle('/Users/bytedance/proj/pi', { home: HOME, copyPathsAsAbsolute: undefined }))
      .toBe('~/proj/pi')
  })

  it('默认档（copyPathsAsAbsolute === false）也缩写', () => {
    expect(applyCopyPathStyle('/Users/bytedance/proj/pi', { home: HOME, copyPathsAsAbsolute: false }))
      .toBe('~/proj/pi')
  })

  it('开关打开（copyPathsAsAbsolute === true）→ 原样绝对路径，一个字符都不动', () => {
    // 变异靶子 (b)：让实现忽略开关（永远缩写），这一条立刻红。
    expect(applyCopyPathStyle('/Users/bytedance/proj/pi', { home: HOME, copyPathsAsAbsolute: true }))
      .toBe('/Users/bytedance/proj/pi')
  })

  it('多选逐行各自缩写，用换行拼接', () => {
    const input = '/Users/bytedance/a.ts\n/Users/bytedanceOTHER/b.ts\n/etc/c'
    // 第一行缩写、第二行是别人 home 不动、第三行 home 外不动——三行一起钉死，不写 every/some。
    expect(applyCopyPathStyle(input, { home: HOME, copyPathsAsAbsolute: undefined }))
      .toBe('~/a.ts\n/Users/bytedanceOTHER/b.ts\n/etc/c')
  })
})
