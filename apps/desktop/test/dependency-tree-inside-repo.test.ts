import { execFileSync } from 'node:child_process'
import { readdirSync, readlinkSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 装好的依赖树整个落在仓内，没有一条链接指向仓外。
 *
 * 来由：曾经整个 workspace 的 `node_modules`（含 vitest 自身）指向 `/private/tmp/agentmux-package-*`。
 * 那是从脏工作树打 macOS 包时留下的状态——打包走 detached worktree + `cp -cR` 克隆 node_modules
 * （本仓无法从零 pnpm install），中断或顺序出错就会把仓里的 `node_modules` 换成指向临时目录的链接。
 *
 * 这个状态**危险且悄无声息**：`/private/tmp` 由系统按时清理，也可能被下一次打包删掉。一旦清掉，
 * 装的东西整片消失，而在那之前测试照常全绿——跑测试的 vitest 自己就在那条链接后面，所以
 * 「测试能跑」恰恰不能证明依赖树是好的。它还会让 gate 的结论失去意义：门跑的是仓外那份树。
 *
 * 判据是**链接指向哪里**，不是「有没有 symlink」。pnpm 的整个机制就建立在仓内相对链接上
 * （`node_modules/vitest -> .pnpm/vitest@…/node_modules/vitest`），禁掉 symlink 会让守卫必然误报
 * 而被删掉。真正的错是**目标解析后落在仓外**，与写法（绝对/相对/多级 `../`）无关——所以一律
 * `resolve` 到绝对路径再判前缀，而不是看 `readlink` 的字面量以 `/` 开头。
 *
 * 这条是「手工清理不留检测器等于没清」的又一处：#116 那次的前提在事后复查时已不成立（实测 0 处），
 * 但打包流程原样保留，同样的操作会再次留下同样的状态。清理只作用于当时的树，守卫挡的是下一次。
 */

/** 仓根绝对路径。测试文件在 `apps/desktop/test/`，往上三层。 */
const REPOSITORY = resolve(new URL('../../../', import.meta.url).pathname)

/**
 * 依赖树里每一条 symlink 及其解析后的绝对目标。
 *
 * 只走 `node_modules`：源码树里的链接（若有）是另一类事，由 workspace-files 那族守。`.pnpm` 内部
 * 逐个包再往下钻会是几十万个 inode，所以在 `.pnpm/<包>/node_modules` 这一层停住——仓外指向若发生，
 * 一定发生在被换掉的 `node_modules` 根或某个包的根上，不会只藏在深处某个传递依赖里。
 */
function dependencyLinks(): { path: string; target: string }[] {
  const roots = execFileSync('git', ['ls-files', '-z', '--', '*package.json'], {
    cwd: REPOSITORY,
    maxBuffer: 64 * 1024 * 1024
  })
    .toString('utf8')
    .split('\0')
    .filter((path) => path && !path.includes('node_modules/'))
    .map((path) => join(REPOSITORY, path.replace(/package\.json$/, 'node_modules')))

  const out: { path: string; target: string }[] = []
  const walk = (directory: string, depth: number): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(directory)
    } catch {
      return // 这个 workspace 还没装依赖——没有链接可查。
    }
    for (const entry of entries) {
      const path = join(directory, entry)
      let link: string
      try {
        link = readlinkSync(path)
      } catch {
        // 不是链接。目录继续往下，但只在有限深度内（见上面那段说明）。
        if (depth > 0) {
          try {
            if (statSync(path).isDirectory()) walk(path, depth - 1)
          } catch {
            continue
          }
        }
        continue
      }
      out.push({ path, target: resolve(directory, link) })
    }
  }
  for (const root of roots) walk(root, 2)
  return out
}

describe('依赖树整个落在仓内', () => {
  it('扫描真的看到了依赖树，而不是一份空清单', () => {
    // 没有这条，任何让遍历返回空的错误（路径拼错、只查了一个 workspace、readdir 全失败）都会让
    // 下面的禁令靠"什么也没扫到"变绿。本仓踩过多次这个形态。
    const links = dependencyLinks()
    // pnpm 的整棵树由链接构成，数量级必然很大；实测 2026-09-01 为数千条。
    expect(links.length, '一条依赖链接都没扫到——依赖没装，或遍历路径拼错了').toBeGreaterThan(100)
    // vitest 自己必须在其中：它就是跑这条测试的东西，也正是那次事故里被换掉的链接。
    expect(
      links.some(({ path }) => path.endsWith('/node_modules/vitest')),
      'vitest 的链接不在扫描结果里——遍历没覆盖仓根 node_modules'
    ).toBe(true)
  })

  it('没有任何依赖链接的目标落在仓外', () => {
    // 判据：解析后的绝对目标必须在仓根之下。写法无关——绝对路径、相对路径、层层 `../` 都一样过这条。
    const escaping = dependencyLinks()
      .filter(({ target }) => target !== REPOSITORY && !target.startsWith(`${REPOSITORY}/`))
      .map(({ path, target }) => `${path.slice(REPOSITORY.length + 1)} -> ${target}`)

    expect(escaping).toEqual([])
  })
})
