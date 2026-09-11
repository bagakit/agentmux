import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Gate 点名的测试文件必须真的存在。
 *
 * 守的是一种**静默少跑**：`vitest run a.test.ts b.test.ts`，当 `a` 不存在而 `b` 存在时，
 * vitest **退 0，且摘要里根本不提 a**——只说 `Test Files 1 passed (1)`。于是一条点名三个文件的
 * gate 实际只跑了一个，收据上写着绿。实测（2026-09-26）：
 *
 *   $ pnpm --filter @agentmux/desktop exec vitest run \
 *       test/run-process-status-convergence.test.ts test/working-count-convergence.test.ts \
 *       test/agent-attention.test.ts
 *   Test Files  2 passed (2)        # 点名 3 个，跑了 2 个
 *   EXIT=0
 *
 * 注意**只有全部文件都不存在**时 vitest 才退 1（"No test files found"）。混合情形是退 0 的，
 * 所以这一族假绿恰好出现在「大部分判据还在、少了一两条」的时候——最不容易被看出来的那种。
 *
 * 两条容易把结论算错的规则，都吃过（本文件第一版两条都错，报出 159 个"缺失"，真实是 15 个）：
 *
 * 1. **vitest 的 filter 是子串匹配，不是路径相等。** gate 写 `working-count-convergence.test.ts`
 *    而磁盘上是 `.test.tsx`，那个文件**照样会跑**——`.ts` 是 `.tsx` 的前缀。所以「扩展名写错了」
 *    不是缺陷，判据必须按前缀匹配去核，否则会报一堆假缺陷（记忆 guard-can-point-at-the-wrong-conclusion）。
 * 2. **cwd 来自 `cd X &&` 或 `--filter <pkg>`。** 把 `--filter @agentmux/core` 的相对路径当成
 *    仓根解析，会把每一条 core gate 都算成缺失。
 *
 * 判据只覆盖**无守卫**的命令：带 `test -f … &&` 的那些是「实现前预写路径」，缺失时守卫短路，
 * 是有意的。也跳过 `todo`——还没开工的任务点名一个还没写的测试是正常的。红的只有一种情形：
 * 一个**已经在推进或已经签收**的任务，它的 gate 正在问空气。
 */

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..')
const trackerFeatures = join(repositoryRoot, '.bagakit/feature-tracker/features')

/** `--filter <pkg>` 与 pnpm workspace 包目录的对应。写死是对的：它就是 workspace 的形状。 */
const FILTER_DIRECTORIES: Readonly<Record<string, string>> = {
  '@agentmux/core': 'packages/core',
  '@agentmux/desktop': 'apps/desktop',
  '@agentmux/layout': 'packages/layout'
}

/** gate 命令跑在哪个目录下。`cd X &&` 优先，其次 `--filter`，都没有就是仓根。 */
function commandDirectory(command: string): string {
  const cd = /cd\s+(\S+)\s*&&/.exec(command)
  if (cd) {
    const path = cd[1]
    return path.startsWith('/') ? relative(repositoryRoot, path) : path
  }
  const filter = /--filter\s+(\S+)/.exec(command)
  const mapped = filter ? FILTER_DIRECTORIES[filter[1]] : undefined
  return mapped ?? '.'
}

type Named = { feature: string; task: string; status: string; path: string }

function namedTestFiles(): { named: Named[]; commands: number } {
  const named: Named[] = []
  let commands = 0
  for (const feature of readdirSync(trackerFeatures)) {
    const tasksFile = join(trackerFeatures, feature, 'tasks.json')
    if (!existsSync(tasksFile)) continue
    const parsed = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks?: Array<{
        id?: string
        status?: string
        verification?: Array<{ kind?: string; ref?: string }>
      }>
    }
    for (const task of parsed.tasks ?? []) {
      const status = task.status ?? 'unknown'
      // `todo` 点名未来的测试是正常的；cancelled/transferred 已经不作数。
      if (status === 'todo' || status === 'cancelled' || status === 'transferred') continue
      for (const verification of task.verification ?? []) {
        if (verification.kind !== 'command') continue
        // `#` 之后是判据注释，里面常引用别的文件名，不是要跑的东西。
        const command = (verification.ref ?? '').split('#')[0]
        if (!command.includes('vitest')) continue
        // 带存在性守卫的命令缺失时会短路，那是预写路径，不是断链。
        if (command.includes('test -f') || command.includes('test -e')) continue
        commands += 1
        const directory = commandDirectory(command)
        for (const token of command.match(/\S*\.test\.[cm]?[jt]sx?\b/g) ?? []) {
          named.push({
            feature,
            task: task.id ?? 'unknown',
            status,
            path: normalize(join(directory, token))
          })
        }
      }
    }
  }
  return { named, commands }
}

/**
 * 已知的断链，冻结成基线。
 *
 * 为什么是棘轮而不是当场修：gate ref 归 tracker 所有，而 `tasks.json` 被 `owner-receipt.json`
 * 逐字节 sha256 钉住，手改会打断绑定（实测过一次，见记忆 tracker-json-is-hashed-and-gitignored），
 * 正路是走 `feature-tracker.sh`。所以这份表的作用是**止损**：这六条已经这样了，但第七条不许再长出来。
 *
 * 维护约定与 `apps/desktop/test/type-tree-error-baseline.ts` 同款：修好一条就从表里**删掉**它，
 * 之后它再冒出来会被逮住。**绝不允许**往表里加一行让守卫变绿——那正是本守卫要消灭的动作。
 * 判据是**逐条相等**而非「不得超过」：上限式棘轮对「加一行」在定义上就是放行的。
 */
const KNOWN_BROKEN_GATES: readonly string[] = [
  // 两条已签收（done）的 gate 各点名一个从不存在的文件。**能力本身在场**，缺的是收据：
  // - f-27q8fjs45/T-006「Executor 身份贯穿各表面」：`AgentAvatar.tsx:39` 真的在解析 executorId，
  //   且同一条 gate 里的 `agent-avatar-settings.test.tsx` 存在且 10 项全绿。
  // - f-29r8fvgbg/T-001「修正停止态语义并显示 idle 计数」：验收第 3 条（waiting/blocked/error
  //   仍可辨识、exited 是中性事实）的真实归属是 `agent-avatar-state-visual.test.tsx`。
  'done f-27q8fjs45/T-006 -> apps/desktop/test/executor-identity-ownership.test.tsx',
  'done f-29r8fvgbg/T-001 -> apps/desktop/test/agent-attention.test.ts',
  // 这一条不一样：它是 `failed`，而 gate 点名的文件不存在，全仓也没有任何测试覆盖 stranded claim。
  // 也就是说它的验收命令在当前状态下**永远不可能通过**。见
  // `docs/reviews/prompt-readiness-gate-contradiction-2026-09-26.md`——它与 prompt readiness 那条
  // 矛盾是同一个子系统的两头。
  'failed f-25q8fccdm/T-007 -> packages/core/test/prompt-submission-stranded-claim.test.ts',
  // f-27a8f3deq/T-002 是 in_progress 且 last_blocker 明写「唯一正确的实现路径穿过一个本轮不得编辑
  // 的文件」。三个文件都还没写，属实现前预写路径——但这条 gate 自己带了数量判据
  // （`# 判据：摘要须为 Test Files 6 passed`），所以它不会静默少跑，是三条里唯一自带防护的。
  'in_progress f-27a8f3deq/T-002 -> apps/desktop/test/agent-monogram.test.ts',
  'in_progress f-27a8f3deq/T-002 -> apps/desktop/test/conversation-avatar-color.test.ts',
  'in_progress f-27a8f3deq/T-002 -> apps/desktop/test/selector-list-presence.test.tsx'
]

describe('tracker gate 点名的测试文件', () => {
  it('每一个都在磁盘上（或被子串匹配到），否则那条 gate 在静默少跑', () => {
    const { named, commands } = namedTestFiles()

    // 前提自检。tracker 搬走、JSON 换形状、正则失配，都会让下面那条断言在扫到空内容时
    // 恒绿——那正是本文件要消灭的形状（记忆 scan-cannot-tell-volatile-from-stable 同族）。
    expect(commands, 'tracker 里一条 vitest gate 都没扫到——路径或 JSON 形状变了，这条判据在问空气')
      .toBeGreaterThan(0)
    expect(named.length, '扫到了 gate 命令却没解析出任何测试文件名——正则失配了')
      .toBeGreaterThan(0)

    const missing = named.filter((entry) => {
      const absolute = join(repositoryRoot, entry.path)
      if (existsSync(absolute)) return false
      // vitest 的 filter 是子串：`x.test.ts` 会匹配到 `x.test.tsx`。前缀命中即算跑到了。
      return globSync(`${absolute}*`).length === 0
    })

    expect(
      missing.map((entry) => `${entry.status} ${entry.feature}/${entry.task} -> ${entry.path}`).sort(),
      '这些 gate 点名了磁盘上不存在的测试文件。vitest 混合情形退 0 且不提缺的那个，'
        + '于是收据上是绿的而判据少跑了。修法是走 feature-tracker.sh 把 gate 指向真实文件，'
        + '或把缺的那条测试写出来——不是往 KNOWN_BROKEN_GATES 里加一行'
    ).toEqual([...KNOWN_BROKEN_GATES].sort())
  })
})

