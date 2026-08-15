import { defaultExclude, defineConfig } from 'vitest/config'

/**
 * 嵌套 worktree 里的测试**不属于**本次运行。
 *
 * `EnterWorktree` 把工作树建在 `.claude/worktrees/<name>/`，也就是仓库**内部**，于是那里有一份
 * 完整的源码树。vitest 的默认 exclude 只挡 `node_modules` / `dist` / `.{idea,git,cache,output,temp}`，
 * 不挡 `.claude`，所以每一条 `vitest run` 都会把并行同事分支上的旧副本一起收进来。
 *
 * 实测（2026-09-01）：收集到 532 个测试文件，其中 **265 个来自 `.claude/worktrees/`**——整个测试
 * 面翻了一倍，一半是别人分支上的旧代码。后果是双向的：别人分支上的红会打红我的门禁，别人分支上的
 * 绿会替我背书。`pnpm test:native` 那条尤其干净地暴露了它——末尾参数是**子串过滤**而不是路径，
 * `.claude/worktrees/<peer>/packages/core/test/package-consumer.integration.test.ts` 同样包含
 * 那个子串，而 `pnpm --filter @agentmux/core build` 只建主树的 dist，于是那份副本必然在 ~20ms
 * 报 `ENOENT … packages/core/dist/agentmux.js`。这跟被测代码毫无关系，纯粹是范围没框住。
 *
 * 排的是「本仓自己的嵌套 worktree」这个概念，不是某个同事的分支名——分支来去自由，位置是约定。
 * glob 相对 vitest 的 root（这里就是仓根）解析，所以下面那条已经够；再前置一段任意深度通配是多余的，
 * 实测两种写法收集结果完全一致。
 * `defaultExclude` 从 `vitest/config` 取而不是手抄：抄下来就会在 vitest 升级时静默漂移。
 */
export default defineConfig({
  test: {
    exclude: [...defaultExclude, '.claude/worktrees/**'],
    // 见 vitest.dist-freshness.ts：desktop 经 dist 消费 @agentmux/core，dist 陈旧时整个 desktop
    // 测试面会为上一次构建的 Core 背书。放 globalSetup 而不是测试文件，是因为路径过滤在收集阶段
    // 就把没点名的测试文件挡掉了——那里的守卫只在不需要它的那些次运行里生效。
    globalSetup: ['./vitest.dist-freshness.ts'],
    // 见 vitest.setup.ts：把测试夹具跑的 git 与开发者本人的 gitconfig 隔开。
    setupFiles: ['./vitest.setup.ts']
  }
})
