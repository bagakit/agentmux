import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'

/**
 * 嵌套 worktree 里的测试**不属于**本次运行。
 *
 * 工具会把工作树建在仓库**内部**（`.claude/worktrees/<name>/`、`.worktrees/<name>/`），于是那里有
 * 一份完整的源码树。vitest 的默认 exclude 只挡 `node_modules` / `dist` / `.{idea,git,cache,output,
 * temp}`，这些目录一个都不挡，所以每一条 `vitest run` 都会把并行同事分支上的旧副本一起收进来。
 *
 * 实测（2026-09-01）：收集到 532 个文件，其中 **265 个来自 `.claude/worktrees/`**——整个测试面翻
 * 了一倍，一半是别人分支上的旧代码。后果是双向的：别人分支上的红会打红我的门禁，别人分支上的绿会
 * 替我背书。`pnpm test:native` 那条尤其干净地暴露了它——末尾参数是**子串过滤**而不是路径，
 * `.claude/worktrees/<peer>/packages/core/test/package-consumer.integration.test.ts` 同样包含那个
 * 子串，而 `pnpm --filter @agentmux/core build` 只建主树的 dist，于是那份副本必然在 ~20ms 报
 * `ENOENT … packages/core/dist/agentmux.js`。这跟被测代码毫无关系，纯粹是范围没框住。
 *
 * ## 为什么不再写死目录名
 *
 * 上面那条规则此前写成一个字面量 `'.claude/worktrees/**'`，而它只挡住了当时见过的那一个位置。
 * 2026-09-14 实测：另一个工具在 `.worktrees/wt-<feature-id>/` 下建了工作树，于是同一个缺陷原样
 * 复发——收集到 **1139** 个文件，其中 **567 个**来自那里。字面量清单守的是「我见过的位置」，而问题
 * 的定义是「仓库内部的另一棵工作树」；两者不是一回事，差额就是下一次复发。
 *
 * 所以改成向 `git worktree list` 要答案——那是这个问题在这台机器上的唯一权威，它知道每一棵工作树
 * 在哪，包括还没被发明出来的那些命名约定。落在仓库外面的工作树（比如打包用的 `/private/tmp/...`）
 * 本来就不会被收集，`relative()` 算出来带 `..` 或是绝对路径，据此跳过。
 *
 * 拿不到 git（不在仓库里、没装 git）时退回到已知的两个前缀：这不是"兜底吞掉错误"，而是因为这两个
 * 位置是本仓的约定，即使无法枚举也仍然该排。`defaultExclude` 从 `vitest/config` 取而不是手抄：
 * 抄下来就会在 vitest 升级时静默漂移。
 */
function nestedWorktreeGlobs(): string[] {
  const conventional = ['.claude/worktrees/**', '.worktrees/**']
  let listing: string
  try {
    listing = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: import.meta.dirname,
      encoding: 'utf8'
    })
  } catch {
    return conventional
  }
  const nested = listing
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => relative(import.meta.dirname, line.slice('worktree '.length).trim()))
    // 空串是主树自己；`..` 开头或绝对路径的落在仓库外面，收集器本来就够不着。
    .filter((path) => path !== '' && !path.startsWith('..') && !path.startsWith('/'))
    .map((path) => `${path}/**`)
  return [...new Set([...conventional, ...nested])]
}

export default defineConfig({
  test: {
    exclude: [...defaultExclude, ...nestedWorktreeGlobs()],
    // 见 vitest.dist-freshness.ts：desktop 经 dist 消费 @agentmux/core，dist 陈旧时整个 desktop
    // 测试面会为上一次构建的 Core 背书。放 globalSetup 而不是测试文件，是因为路径过滤在收集阶段
    // 就把没点名的测试文件挡掉了——那里的守卫只在不需要它的那些次运行里生效。
    globalSetup: ['./vitest.dist-freshness.ts'],
    // 见 vitest.setup.ts：把测试夹具跑的 git 与开发者本人的 gitconfig 隔开。
    setupFiles: ['./vitest.setup.ts']
  }
})
