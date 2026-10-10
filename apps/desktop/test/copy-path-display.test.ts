import { win32 as _historyWin32 } from 'node:path'
// Derive synthetic directory labels from this fixture module; only drive/UNC grammar is fixed.
function _historyWindowsFixturePath(volume: string, relative: string): string {
  const label = _historyFixturePath('windows-path-cases').split(/[\\/]/u).filter(Boolean).map(segment => segment.replace(/[<>:"|?*]/gu, '-')).join('-')
  const [head, ...tail] = relative.split('/')
  const sep = _historyWin32.sep
  const root = volume === 'unc' ? sep.repeat(2) + label + '-server' + sep + label + '-' + head + sep : volume + ':' + sep + label + '-' + head
  return _historyWin32.join(root, ...tail)
}

import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { abbreviateHomePath, applyCopyPathStyle, summarizeRelatedPath } from '../src/renderer/src/lib/copy-path-display.js'

/**
 * 复制路径的家目录缩写。设计 SSOT《寻址与复制》「复制出来的路径默认用 `~`」那几条的可执行判据：
 *   1. 缩写只在「这确实是当前用户的家目录」时发生——边界必须是 `home` 本身或 `home + '/'`，
 *      **不是** `startsWith(home)`，否则 `fixtureRoot/tmp/alice-homeOTHER/x` 会被剥成 `~OTHER/x`（点名的反例）。
 *   2. 开关（`copyPathsAsAbsolute`）能关掉缩写、给绝对路径；默认（缺席/false）缩写。
 *   3. `home` 空（渲染层还没拿到本机 home）时不缩写——宁可长，不可错。远程主机的路径由调用方
 *      负责不把本机 home 传进来，这个纯函数只管边界。
 *
 * 期望值全是写死的字面量，不由被测函数自己算（本仓 weak-assertion 陷阱）。
 */
describe('abbreviateHomePath: 缩写只按真实 home 值判边界', () => {
  const HOME = _hygiene_fixturePath("tmp/alice-home")

  it('路径恰好是 home 本身 → ~', () => {
    expect(abbreviateHomePath(_hygiene_fixturePath("tmp/alice-home"), HOME)).toBe('~')
  })

  it('home + "/" 前缀 → ~ 接其余部分（用户报的那种）', () => {
    expect(abbreviateHomePath(_hygiene_fixturePath("tmp/alice-home/proj/github/pi"), HOME)).toBe('~/proj/github/pi')
  })

  it('别人的家目录不被误缩写——判据是 home 值不是路径长相（设计 SSOT 点名的反例）', () => {
    // 变异靶子 (a)：把边界写成 `startsWith(home)`，这一条立刻红——它会切成 `~OTHER/x`。
    expect(abbreviateHomePath(_hygiene_fixturePath("tmp/alice-homeOTHER/x"), HOME)).toBe(_hygiene_fixturePath("tmp/alice-homeOTHER/x"))
  })

  it('home 是前缀但下一段不是路径分隔 → 原样（同一反例的另一面）', () => {
    // `fixtureRoot/tmp/alice-home-backup` 以 `home` 开头，但 home 后面不是 `/`，所以不是 home 之内。
    expect(abbreviateHomePath(_hygiene_fixturePath("tmp/alice-home-backup/x"), HOME)).toBe(_hygiene_fixturePath("tmp/alice-home-backup/x"))
  })

  it('不在 home 之下的绝对路径 → 原样', () => {
    expect(abbreviateHomePath('/etc/hosts', HOME)).toBe('/etc/hosts')
  })

  it('home 为空（本机 home 未知）→ 一律原样，绝不拿空串去猜', () => {
    expect(abbreviateHomePath(_hygiene_fixturePath("tmp/alice-home/proj"), '')).toBe(_hygiene_fixturePath("tmp/alice-home/proj"))
  })
})

describe('summarizeRelatedPath: confirmed related paths retain the original display fallback', () => {
  it.each([
    ['same directory', _hygiene_fixturePath('projects/repo'), _hygiene_fixturePath('projects/repo'), '~/projects/repo', '.'],
    ['nested directory', _hygiene_fixturePath('projects/repo/topic'), _hygiene_fixturePath('projects/repo'), '~/projects/repo/topic', './topic'],
    ['sibling worktree', _hygiene_fixturePath('projects/topic'), _hygiene_fixturePath('projects/repo'), '~/projects/topic', '../topic'],
    ['shared filesystem root only', _hygiene_fixturePath('other/topic'), _hygiene_fixturePath('projects/repo'), '~/other/topic', '~/other/topic'],
    ['relative source', 'projects/topic', _hygiene_fixturePath('projects/repo'), 'projects/topic', 'projects/topic'],
    ['relative base', _hygiene_fixturePath('projects/topic'), 'projects/repo', '~/projects/topic', '~/projects/topic'],
    ['shorter original display', _hygiene_fixturePath('projects/topic'), _hygiene_fixturePath('projects/repo'), 'topic', 'topic'],
    ['Windows sibling', _historyWindowsFixturePath("C", "projects/topic"), _historyWindowsFixturePath("C", "projects/repo"), _historyWindowsFixturePath("C", "projects/topic"), '../topic'],
    ['shared drive only', _historyWindowsFixturePath("C", "other/topic"), _historyWindowsFixturePath("C", "projects/repo"), _historyWindowsFixturePath("C", "other/topic"), _historyWindowsFixturePath("C", "other/topic")],
    ['different drives', _historyWindowsFixturePath("D", "projects/topic"), _historyWindowsFixturePath("C", "projects/repo"), _historyWindowsFixturePath("D", "projects/topic"), _historyWindowsFixturePath("D", "projects/topic")],
    ['UNC sibling', _historyWindowsFixturePath("unc", "share/topic"), _historyWindowsFixturePath("unc", "share/repo"), _historyWindowsFixturePath("unc", "share/topic"), '../topic'],
    ['different UNC shares', _historyWindowsFixturePath("unc", "other/topic"), _historyWindowsFixturePath("unc", "share/repo"), _historyWindowsFixturePath("unc", "other/topic"), _historyWindowsFixturePath("unc", "other/topic")]
  ])('%s', (_label, path, base, displayed, expected) => {
    expect(summarizeRelatedPath(path!, base!, displayed!)).toBe(expected)
  })
})

describe('applyCopyPathStyle: 开关与逐行缩写', () => {
  const HOME = _hygiene_fixturePath("tmp/alice-home")

  it('默认档（copyPathsAsAbsolute 缺席）缩写', () => {
    expect(applyCopyPathStyle(_hygiene_fixturePath("tmp/alice-home/proj/pi"), { home: HOME, copyPathsAsAbsolute: undefined }))
      .toBe('~/proj/pi')
  })

  it('默认档（copyPathsAsAbsolute === false）也缩写', () => {
    expect(applyCopyPathStyle(_hygiene_fixturePath("tmp/alice-home/proj/pi"), { home: HOME, copyPathsAsAbsolute: false }))
      .toBe('~/proj/pi')
  })

  it('开关打开（copyPathsAsAbsolute === true）→ 原样绝对路径，一个字符都不动', () => {
    // 变异靶子 (b)：让实现忽略开关（永远缩写），这一条立刻红。
    expect(applyCopyPathStyle(_hygiene_fixturePath("tmp/alice-home/proj/pi"), { home: HOME, copyPathsAsAbsolute: true }))
      .toBe(_hygiene_fixturePath("tmp/alice-home/proj/pi"))
  })

  it('多选逐行各自缩写，用换行拼接', () => {
    const input = (_hygiene_fixturePath("tmp/alice-home/a.ts") + "\n" + _hygiene_fixturePath("tmp/alice-homeOTHER/b.ts") + ("\n" + _hygiene_fixturePath("etc/c")))
    // 第一行缩写、第二行是别人 home 不动、第三行 home 外不动——三行一起钉死，不写 every/some。
    expect(applyCopyPathStyle(input, { home: HOME, copyPathsAsAbsolute: undefined }))
      .toBe(("~/a.ts\n" + _hygiene_fixturePath("tmp/alice-homeOTHER/b.ts") + ("\n" + _hygiene_fixturePath("etc/c"))))
  })
})
