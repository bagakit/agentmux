import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', 'src', 'renderer', 'src')
function filesUnder(dir: string): string[] {
  // `encoding: 'utf8'` 选的是返回 string[] 的那个重载。不给的话签名是 `string[] | Buffer[]`，
  // 下面的 `endsWith` 在 tsc 里不成立——而这一整棵 test 树直到 2026-09-07 才开始被编译，所以
  // 这处从写下来就没编译过。
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(dir, entry))
}

describe('full-page loading production callers', () => {
  it('has real callers outside the shared definition', () => {
    const definition = join(root, 'components', 'FullPageLoadingSurface.tsx')
    // 自检：定义文件真的在扫描面里。写错路径时下面的 `!== definition` 恒真、`includes` 一个都不
    // 命中，于是判据在「一个调用者都没有」和「路径打错了」之间分不出来。
    expect(filesUnder(root)).toContain(definition)

    const callers = filesUnder(root).filter((file) => file !== definition && readFileSync(file, 'utf8').includes('FullPageLoadingSurface'))
    // 判的是「这个共用表面真的被产品用上了，而且不止一处」——即零调用者检查。
    //
    // 不再钉一份调用者名单：名单是手抄的，而来源会长。它从 3 个长到 5 个（BrowserPane、
    // SessionConnectingSurface 接上来），于是这条红了——红的是名单过期，不是能力回归，
    // 而这个 Feature 的目标恰恰是让更多整页加载收敛到这里。名单在这里只会把进展报成缺陷。
    expect(callers.length).toBeGreaterThanOrEqual(2)
  })
})
