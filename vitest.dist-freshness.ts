import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 跑任何测试之前，先钉住「`packages/core/dist` 是当前 `packages/core/src` 的产物」。
 *
 * 为什么这件事非守不可：`@agentmux/core` 的 `package.json` 把 `types`/`import` 指向 `./dist/*`
 * （不是 `src`，`packages/layout` 才是指向 src 的那种）。于是 **desktop 的每一条测试都在加载 dist**
 * （实测 `apps/desktop/test` 下 65 个文件 import 了 `@agentmux/core`），desktop 的 `tsc` 也只读
 * `dist/*.d.ts`。dist 陈旧时，两者都照旧全绿——绿的是上一次构建的 Core，不是树里这份。
 *
 * 仓库的规范脚本本来就挡住了这一面：`pnpm typecheck` / `test:fast` / `test:native` 每条都前置
 * `pnpm --filter @agentmux/core build`。挡不住的是**日常真正的跑法**——`npx vitest run <某个文件>`。
 * 那条命令不经过任何 pnpm 脚本，于是加载磁盘上碰巧存在的那份 dist。本仓的测试纪律要求从仓根裸跑
 * vitest（见 AGENTS.md），所以这不是边角用法，而是主用法。
 *
 * ## 为什么是 globalSetup 而不是一个测试文件
 *
 * 这道判据此前以一个私有函数的形态活在 `packages/core/test/package-consumer.integration.test.ts`
 * 里，被三重关在里面：它只在 `describe.runIf(darwin && arm64)` 里调用；那个文件被 `test:fast`
 * 用 `--exclude` 排掉；唯一会跑它的 `test:native` 又自己前置了 build——也就是说它**永远不可能红**。
 *
 * 把它搬进一个新的测试文件解决不了这件事，而且原因是结构性的：**vitest 的路径过滤在收集阶段就
 * 生效，没被点名的测试文件根本不加载**。实测（vitest 3.2.7）：一个必红的守卫测试文件，配上
 * `vitest run other/b.test.ts`，退出码 0，守卫一次也没跑。一个只在「你恰好点名了它」时才生效的
 * 守卫，守的正好是不需要守的那些次运行。
 *
 * `globalSetup` 没有这个性质：它在项目初始化时跑，早于收集，与点名了哪些路径无关；从子目录跑
 * （`packages/core` 没有自己的 vitest 配置，会向上找到仓根这份）同样生效；抛出即整次运行退出 1。
 * 两条都是实测过的，不是照文档推的。
 *
 * ## 判据
 *
 * `src` 里**最新**的 mtime 与 `dist` 里**最旧**的 mtime 相比：任何一个源文件比任何一个产物新，
 * 这份 dist 就不完整地对应当前源码。只比目录 mtime 不够——改文件内容不动目录 mtime。
 * 入口缺失（build 没跑，或跑到一半失败）单独先报，错因比「目录空」清楚得多。
 *
 * 代价是每次跑测试多 ~20ms（实测 83 + 250 个文件的 stat 扫描），以及一个真实的摩擦：并发同事一改
 * `packages/core/src`，我这边下一次裸跑 vitest 就红。那句红是**真话**——我加载的 dist 确实不是树里
 * 这份源码——而消解它只要 3 秒（实测 `pnpm --filter @agentmux/core build` 3.18s）。所以错误文案
 * 第一行就是那条命令。不设跳过开关：能跳过的守卫等于没有守卫。
 */

const repositoryRoot = import.meta.dirname
const packageDirectory = resolve(repositoryRoot, 'packages/core')
const rebuild = 'pnpm --filter @agentmux/core build'

async function extremeModification(
  directory: string,
  wins: (candidate: number, incumbent: number) => boolean
): Promise<{ path: string; at: number } | undefined> {
  let held: { path: string; at: number } | undefined
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const at = (await stat(path)).mtimeMs
    if (!held || wins(at, held.at)) held = { path, at }
  }
  return held
}

export default async function assertCoreDistBuiltFromCurrentSource(): Promise<void> {
  const entryPoint = join(packageDirectory, 'dist', 'index.js')
  try {
    await stat(entryPoint)
  } catch {
    throw new Error(
      `先跑 \`${rebuild}\`：packages/core/dist/index.js 不存在。` +
        'desktop 的测试与 tsc 都经 dist 消费 @agentmux/core，没有它这次运行测的是空气。'
    )
  }

  const newestSource = await extremeModification(join(packageDirectory, 'src'), (a, b) => a > b)
  const oldestArtifact = await extremeModification(join(packageDirectory, 'dist'), (a, b) => a < b)
  // 两个 undefined 分支不是防御性代码，是扫描根写错时的判别器：目录不存在会在上面 readdir 抛，
  // 而一个**存在但空**的目录会让下面的比较无声通过（本仓记过 false-green-gate-patterns：
  // 「扫描根写错」与「空集合满足一切断言」是同一族假绿的两个入口）。
  if (!newestSource) throw new Error('packages/core/src 下一个文件都没有——扫描根写错了。')
  if (!oldestArtifact) throw new Error(`packages/core/dist 是空的：先跑 \`${rebuild}\`。`)

  if (oldestArtifact.at <= newestSource.at) {
    throw new Error(
      `先跑 \`${rebuild}\`：packages/core/dist 比 src 旧，这次运行加载的是上一次构建的 Core。\n` +
        `  最旧产物 ${oldestArtifact.path}\n` +
        `  晚于它的源码 ${newestSource.path}`
    )
  }
}
