import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 一次 `vitest run` 只收本工作树自己的测试，不收嵌套 worktree 里的副本。
 *
 * 来由：`EnterWorktree` 把工作树建在 `.claude/worktrees/<name>/`，也就是仓库**内部**，于是那里躺着
 * 一份完整源码树。vitest 的默认 exclude 只挡 `node_modules` / `dist` / `.{idea,git,cache,output,temp}`，
 * **不挡 `.claude`**，而本仓此前没有任何 vitest 配置文件——全跑默认值。实测（2026-09-01）收集到
 * 532 个测试文件，其中 **265 个来自 `.claude/worktrees/`**：整个测试面翻了一倍，一半是并行同事
 * 分支上的旧代码。
 *
 * 后果是**双向**的，这是它比「多跑一倍时间」严重的地方：同事分支上的红会打红我的门禁，同事分支上的
 * 绿会替我背书。实测的样子——`pnpm test:native` 的末尾参数是**子串过滤**而不是路径，
 * `.claude/worktrees/<peer>/packages/core/test/package-consumer.integration.test.ts` 同样包含那个
 * 子串，而 `pnpm --filter @agentmux/core build` 只建主树的 dist，于是那份副本必然在 ~20ms 报
 * `ENOENT … packages/core/dist/agentmux.js`。一次运行里主树本体 60.8s 通过、退出码却是 1，
 * 差点被读成「负载下仍红」而去追一个不存在的缺陷。
 *
 * 判据是**vitest 实际收了哪些文件**，不是配置文件里有没有那行字。查文本会在两种情形下假绿：
 * exclude 被写进配置但被别处覆盖掉，或者 glob 写错一个字符（少了前导的双星号通配，从
 * `packages/core` 等子目录发起时就不匹配）。所以这里真的去问 vitest。
 */

const REPOSITORY = resolve(new URL('../../../', import.meta.url).pathname)
const NESTED_WORKTREES = join(REPOSITORY, '.claude', 'worktrees')

/**
 * vitest 这次会收的测试文件，仓根相对路径。
 *
 * `--filesOnly` 只做收集不执行，`--exclude` 用来复现 `test:fast` 的形状：CLI 与配置里的 exclude 是
 * **追加**关系而不是替换（实测，非从源码推断），两条路必须都被这一份配置管住。
 */
function collectedFiles(extraExclude: string[] = []): string[] {
  const output = execFileSync(
    'npx',
    [
      'vitest',
      'list',
      '--filesOnly',
      ...extraExclude.flatMap((pattern) => ['--exclude', pattern])
    ],
    {
      cwd: REPOSITORY,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('/') ? resolve(line).slice(REPOSITORY.length + 1) : line))
}

/**
 * 一个**真的**嵌套 worktree 副本，用来在同事的 worktree 不在场时也能证伪。
 *
 * 光靠现存的同事副本立守卫是不够的：那个目录随时会被 remove，守卫会跟着变成恒绿而没人发现。这里
 * 自己在 `.claude/worktrees/` 下摆一个形状相同的测试文件，它必须**也**被排掉。
 */
const PROBE_DIRECTORY = join(NESTED_WORKTREES, '__scope_probe__', 'packages', 'core', 'test')
const PROBE_FILE = join(PROBE_DIRECTORY, 'nested-worktree-probe.test.ts')

afterAll(() => {
  rmSync(join(NESTED_WORKTREES, '__scope_probe__'), { recursive: true, force: true })
})

/**
 * 下面三条各自要起一到两个 `vitest list` 子进程，每个都得把整棵树收集一遍。单跑时约 1s 一次，
 * 而它们跑在**整个 desktop 套件之中**——585 个文件在并发抢 CPU，同一次收集实测到过 6.8s，撞穿
 * vitest 默认的 5s。红出来的样子是 `STACK_TRACE_ERROR`，既不指向 worktree 也不指向 exclude，
 * 于是看起来像「范围守卫发现了什么」，其实只是预算不够。
 *
 * 给一个明确的预算而不是调高全局默认：真的卡死时仍要红，只是不该被同机负载判死。
 */
const SUBPROCESS_BUDGET = 60_000

describe('test scope stays inside this worktree', () => {
  it('collects nothing from .claude/worktrees, including a freshly planted copy', () => {
    mkdirSync(PROBE_DIRECTORY, { recursive: true })
    writeFileSync(
      PROBE_FILE,
      "import { it, expect } from 'vitest'\nit('probe', () => { expect(1).toBe(1) })\n"
    )

    const collected = collectedFiles()
    expect(collected.filter((file) => file.includes('.claude/worktrees'))).toEqual([])

    // 自检：探针文件确实长成 vitest 会认的样子，否则上面那条恒真。把它挪到仓内正常位置就该被收。
    const insideTest = join(REPOSITORY, 'apps', 'desktop', 'test', 'nested-worktree-probe.test.ts')
    writeFileSync(insideTest, "import { it, expect } from 'vitest'\nit('probe', () => { expect(1).toBe(1) })\n")
    try {
      expect(collectedFiles()).toContain('apps/desktop/test/nested-worktree-probe.test.ts')
    } finally {
      rmSync(insideTest, { force: true })
    }
  }, SUBPROCESS_BUDGET)

  it('still excludes them when a script passes its own --exclude', () => {
    // `test:fast` 的形状。CLI exclude 若是替换而非追加，配置里那条会在这条路上失效。
    const collected = collectedFiles([
      'packages/core/test/package-consumer.integration.test.ts'
    ])
    expect(collected.filter((file) => file.includes('.claude/worktrees'))).toEqual([])
    expect(collected).not.toContain('packages/core/test/package-consumer.integration.test.ts')
    expect(collected.length).toBeGreaterThan(200)
  }, SUBPROCESS_BUDGET)

  it('keeps vitest own defaults in the exclude list, instead of a hand-copied subset', () => {
    // 加一条自定义 exclude 时最容易顺手把整个数组写成字面量，于是默认那几条被悄悄丢掉。实测丢掉
    // `**/node_modules/**` 一条，收集量从 268 涨到 1681——多出的 1413 个全在 node_modules 里。
    // 上面两条只查 `.claude/worktrees`，对这种「排除清单本身不完整」完全失明，所以单独钉一条。
    // 判据是**收集结果**里没有默认该挡掉的东西，不是配置文件里出现了 `defaultExclude` 这个词。
    //
    // 只钉 node_modules 一条：默认清单里其余几项（dist / cypress / .git 等）实测去掉后收集量
    // 恒为 268，本仓根本没有落在那些位置的 `*.test.ts`，钉上去只会是一条永远不红的死断言。
    expect(collectedFiles().filter((file) => file.includes('node_modules'))).toEqual([])
  }, SUBPROCESS_BUDGET)

  it('keeps the nested-worktree location a real one, so this guard cannot go vacuously green', () => {
    // 若 `EnterWorktree` 换了落点，上面几条会变成排除一个不存在的目录——绿得毫无意义。
    // 判据不是「同事此刻有没有 worktree」（那来去自由），而是这个约定位置仍是 worktree 的落点。
    const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: REPOSITORY,
      encoding: 'utf8'
    })
    const nested = registered
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .filter((path) => path.startsWith(`${NESTED_WORKTREES}/`))
    expect(nested.length > 0 || existsSync(NESTED_WORKTREES)).toBe(true)
  })
})
