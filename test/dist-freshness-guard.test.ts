import { mkdtemp, writeFile, utimes, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distIsStale, extremeModification } from '../vitest.dist-freshness.js'

// 守卫自己的守卫。
//
// `vitest.dist-freshness.ts` 是一个 globalSetup，**不在任何一次运行的收集面里**——它跑在收集之前，
// 而收集面里没有它。于是它是全仓少数几处「改坏了不会有任何东西报红」的代码之一：审计实测把
// `extremeModification` 的 `wins(...)` 改成恒 false（永远停在第一个文件上，比较两个任意文件），
// 陈旧的 dist 就**不再报红**了，整道守卫静默失效，没有任何用例发现。
//
// 这条用例买的正是那个性质。判据喂的是两个临时目录、自己 utimes 出确定的时间差，不碰
// `packages/core`——那个目录的新鲜度取决于谁刚跑过 build，拿它当 fixture 会让这些断言随并发同事漂。

async function fileAt(directory: string, name: string, seconds: number): Promise<void> {
  const path = join(directory, name)
  await writeFile(path, name)
  await utimes(path, seconds, seconds)
}

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'amx-freshness-'))
}

describe('extremeModification：取的是极值那一个，不是碰到的第一个', () => {
  it('取最新时给出 mtime 最大的那个文件', async () => {
    const root = await scratch()
    // 刻意让「最新的那个」不是目录里的第一个也不是最后一个，于是「恒取第一个」与「恒取最后一个」
    // 两种坏实现都答错。
    await fileAt(root, 'a.ts', 1000)
    await fileAt(root, 'b.ts', 3000)
    await fileAt(root, 'c.ts', 2000)

    const newest = await extremeModification(root, (candidate, incumbent) => candidate > incumbent)
    expect(newest?.path.endsWith('b.ts'), `取到的是 ${newest?.path}，不是 mtime 最大的 b.ts`).toBe(true)
  })

  it('取最旧时给出 mtime 最小的那个文件——同一个函数、相反的比较器', async () => {
    // 两个方向都钉：守卫对 src 用「最新」、对 dist 用「最旧」，只测一个方向的话，把比较器写死成
    // 某一侧仍会半边正确地通过。
    const root = await scratch()
    await fileAt(root, 'a.ts', 3000)
    await fileAt(root, 'b.ts', 1000)
    await fileAt(root, 'c.ts', 2000)

    const oldest = await extremeModification(root, (candidate, incumbent) => candidate < incumbent)
    expect(oldest?.path.endsWith('b.ts'), `取到的是 ${oldest?.path}，不是 mtime 最小的 b.ts`).toBe(true)
  })

  it('递归进子目录——dist 是分层的，只扫顶层会漏掉绝大多数产物', async () => {
    const root = await scratch()
    await fileAt(root, 'top.ts', 1000)
    await mkdir(join(root, 'nested'))
    await fileAt(join(root, 'nested'), 'deep.ts', 5000)

    const newest = await extremeModification(root, (candidate, incumbent) => candidate > incumbent)
    expect(newest?.path.endsWith('deep.ts'), '没有递归进子目录').toBe(true)
  })

  it('空目录给 undefined，而不是一个编出来的极值', async () => {
    // 守卫靠这个 undefined 区分「扫描根写错/build 没跑」与「真的比较过了」。返回一个占位值会让
    // 那两条 throw 永远不触发，于是扫描根写错时整道守卫静默通过。
    expect(await extremeModification(await scratch(), (a, b) => a > b)).toBeUndefined()
  })
})

describe('distIsStale：谁比谁新', () => {
  it('产物比源码旧 → 陈旧', () => {
    expect(distIsStale({ path: 'src/x.ts', at: 2000 }, { path: 'dist/x.js', at: 1000 })).toBe(true)
  })

  it('产物比源码新 → 不陈旧', () => {
    // 与上一条构成两个相反的世界。少了这条，把判据写成恒 true 也照样"通过"。
    expect(distIsStale({ path: 'src/x.ts', at: 1000 }, { path: 'dist/x.js', at: 2000 })).toBe(false)
  })

  it('同一毫秒 → 按陈旧处理', () => {
    // `<=` 与 `<` 的唯一分歧点。相等证明不了「产物晚于源码」，所以报红是安全的那一侧；
    // 这条钉住的是那个选择本身，否则它看起来像个可以随手改的边界。
    expect(distIsStale({ path: 'src/x.ts', at: 1000 }, { path: 'dist/x.js', at: 1000 })).toBe(true)
  })
})
