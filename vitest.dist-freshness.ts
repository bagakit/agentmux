import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 跑任何测试之前，先钉住「`packages/core/dist` 是当前 `packages/core/src` 的产物」。
 *
 * 为什么这件事非守不可：`@agentmux/core` 的 `package.json` 把 `types`/`import` 指向 `./dist/*`
 * （不是 `src`，`packages/layout` 才是指向 src 的那种）。于是 **desktop 的每一条测试都在加载 dist**
 * （实测 `apps/desktop/test` 下 64 个文件 import 了 `@agentmux/core`），desktop 的 `tsc` 也只读
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
/** 消解这道守卫要跑的那条命令。导出给测试断言文案确实点名了它——错误信息第一行就该是可执行的动作。 */
export const rebuild = 'pnpm --filter @agentmux/core build'

/**
 * 目录里 mtime 的极值那一个。`wins` 决定取最新还是最旧。
 *
 * 导出是为了让 `dist-freshness-guard.test.ts` 够得着——这个函数是本守卫唯一有分支的地方，而守卫
 * 自己不在任何测试的收集面里（globalSetup 不是测试文件）。实测过的坏世界：把 `wins(...)` 改成
 * 恒 false，于是永远停在第一个文件上，比较的是两个任意文件，陈旧的 dist **不再报红**——整道守卫
 * 静默失效，而没有任何东西会发现。所以它需要一条自己的用例。
 */
export async function extremeModification(
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

/** 新鲜吗——判据本身，与「去哪个目录问」分开，好让测试喂两个临时目录进来。 */
export function distIsStale(
  newestSource: { path: string; at: number },
  oldestArtifact: { path: string; at: number }
): boolean {
  // `<=` 而不是 `<`：同一毫秒落地的源码与产物说明不了「产物晚于源码」，按陈旧处理是安全的那一侧。
  return oldestArtifact.at <= newestSource.at
}

/**
 * 判据的**全部**，对任意一个 `{ src, dist }` 目录对成立。
 *
 * 取 `packageDirectory` 作参数而不是读模块作用域那个常量，是因为守卫真正会坏的地方不止两个纯函数
 * 内部，还有**它们之间的接线**：哪个目录配哪个比较器。审计实测过这条缝——把 `src` 与 `dist` 的两个
 * 比较器对调，于是拿「src 里最旧的」比「dist 里最新的」，一份真陈旧的 dist 判出 false，守卫静默
 * 放行，而那时的 7 条用例（只测两个纯函数）**全绿**。
 *
 * 参数化之后这条缝可以喂两个临时目录去测，代价只是多一个形参；此前把「必须读真 packages/core」当成
 * 既定事实，其实是那个模块作用域常量造成的，不是问题本身要求的。
 */
export async function staleDistComplaint(packageDirectory: string): Promise<string | null> {
  const entryPoint = join(packageDirectory, 'dist', 'index.js')
  try {
    await stat(entryPoint)
  } catch {
    return (
      `先跑 \`${rebuild}\`：packages/core/dist/index.js 不存在。` +
      'desktop 的测试与 tsc 都经 dist 消费 @agentmux/core，没有它这次运行测的是空气。'
    )
  }

  const newestSource = await extremeModification(join(packageDirectory, 'src'), (a, b) => a > b)
  const oldestArtifact = await extremeModification(join(packageDirectory, 'dist'), (a, b) => a < b)
  // 两个 undefined 分支不是防御性代码，是扫描根写错时的判别器：目录不存在会在上面 readdir 抛，
  // 而一个**存在但空**的目录会让下面的比较无声通过（本仓记过 false-green-gate-patterns：
  // 「扫描根写错」与「空集合满足一切断言」是同一族假绿的两个入口）。
  if (!newestSource) return 'packages/core/src 下一个文件都没有——扫描根写错了。'
  if (!oldestArtifact) return `packages/core/dist 是空的：先跑 \`${rebuild}\`。`

  if (!distIsStale(newestSource, oldestArtifact)) return null
  return (
    `先跑 \`${rebuild}\`：packages/core/dist 比 src 旧，这次运行加载的是上一次构建的 Core。\n` +
    `  最旧产物 ${oldestArtifact.path}\n` +
    `  晚于它的源码 ${newestSource.path}`
  )
}

export default async function assertCoreDistBuiltFromCurrentSource(): Promise<void> {
  const complaint = await staleDistComplaint(packageDirectory)
  if (complaint) throw new Error(complaint)
}
