import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import {
  branchRetentionNote,
  orphanCommitCountArgs,
  parseOrphanCommitCount
} from '../src/shared/lane-orphan-commits.js'
import { orphanCountableRef, type CountableBaseRef } from '../src/shared/base-ref.js'

// ---------------------------------------------------------------------------
// 判据本身用**真 git** 验，不用假 host。
//
// 这条守卫的全部价值在于「git 到底怎么算的」，而假 host 只能证明我们发出了某条命令——那恰恰是
// 本仓反复栽跟头的那种恒真断言。五种 lane 形态里有三种（已并进 base、已推远端、兄弟 lane 互相
// 遮蔽）只有真 git 答得出来，假 host 会把它们全判成一样。
// ---------------------------------------------------------------------------

const host = new LocalExecutionHost()
const roots: string[] = []

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const result = await host.run('git', [
    '-C', repoPath,
    '-c', 'user.name=AgentMux Test',
    '-c', 'user.email=agentmux@example.invalid',
    ...args
  ])
  expect(result.exitCode, `git ${args.join(' ')} failed: ${result.stderr}`).toBe(0)
  return result.stdout
}

/** 一个带远端的仓，base 分支已推送——lane 的各种形态都在它上面长出来。 */
async function repository(): Promise<{ repoPath: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-lane-orphan-'))
  roots.push(root)
  const repoPath = join(root, 'repo')
  const remotePath = join(root, 'origin.git')
  await host.run('git', ['init', '-q', '--bare', remotePath])
  await host.run('git', ['init', '-q', '-b', 'main', repoPath])
  await git(repoPath, 'remote', 'add', 'origin', remotePath)
  await git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'base')
  await git(repoPath, 'push', '-q', 'origin', 'main')
  return { repoPath, base: 'main' }
}

/**
 * base 走的是**生产的那道门**：`orphanCountableRef` 是全仓唯一铸得出可数 ref 的地方，测试里也不例外。
 * 写成 `as CountableBaseRef` 当然更短，但那会让用例走一条生产走不到的路——真正要证的性质（想数就
 * 必须先分级）在类型转换之下恰好消失。
 */
function countable(ref: string): CountableBaseRef {
  const minted = orphanCountableRef({ ref, source: 'remote-head' })
  if (minted === null) throw new Error(`权威来源竟然铸不出可数 ref: ${ref}`)
  return minted
}

async function orphanCount(repoPath: string, branch: string, baseRef: string): Promise<number | null> {
  const result = await host.run('git', orphanCommitCountArgs({ repoPath, branch, baseRef: countable(baseRef) }))
  return parseOrphanCommitCount(result.stdout, result.exitCode)
}

/** 建一条 lane 分支，在它自己的 worktree 里提交 n 次。 */
async function lane(repoPath: string, name: string, commits: number): Promise<void> {
  await git(repoPath, 'branch', name)
  const path = join(repoPath, '..', `wt-${name}`)
  await git(repoPath, 'worktree', 'add', '-q', '--', path, name)
  for (let index = 0; index < commits; index += 1) {
    await git(path, 'commit', '-q', '--allow-empty', '-m', `${name}-${index}`)
  }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('lane 分支上有没有只存在于它自己身上的提交', () => {
  it('有未推送的提交、且没有 upstream —— 必须报出来（aheadBehind 在这一档恰好返回 0）', async () => {
    const { repoPath, base } = await repository()
    await lane(repoPath, 'lane-a', 1)

    // 先证前提：这条分支确实没有 upstream，也就是 aheadBehind 会失明的那种形状。
    const upstream = await host.run('git', [
      '-C', repoPath, 'rev-parse', '--symbolic-full-name', '--verify', '--quiet', 'lane-a@{upstream}'
    ])
    expect(upstream.exitCode, '前提不成立：这条 lane 竟然有 upstream，那这条用例就没在测它要测的东西').not.toBe(0)

    expect(await orphanCount(repoPath, 'lane-a', base)).toBe(1)
  }, 30000)

  it('已经并进 base —— 不报', async () => {
    const { repoPath, base } = await repository()
    await lane(repoPath, 'lane-b', 1)
    await git(repoPath, 'merge', '-q', '--no-ff', '-m', 'merge', 'lane-b')
    expect(await orphanCount(repoPath, 'lane-b', base)).toBe(0)
  }, 30000)

  it('已经推到远端 —— 不报（东西在别处有，删签出不会失联）', async () => {
    const { repoPath, base } = await repository()
    await lane(repoPath, 'lane-c', 1)
    await git(repoPath, 'push', '-q', 'origin', 'lane-c')
    expect(await orphanCount(repoPath, 'lane-c', base)).toBe(0)
  }, 30000)

  it('自己一个提交都没有 —— 不报', async () => {
    const { repoPath, base } = await repository()
    await lane(repoPath, 'lane-d', 0)
    expect(await orphanCount(repoPath, 'lane-d', base)).toBe(0)
  }, 30000)

  /**
   * 这条是整个模块存在的理由。
   *
   * 我先写的判据是「排除自己之外的所有分支」，它在上面四条上全绿，却在这一条上让两条 lane
   * **互相遮蔽**、双双读 0。而同时开好几条 lane 正是 bake-off 的标准玩法——也就是说那版判据
   * 恰好在它最常被用到的场景下全盘失明。
   */
  it('两条 lane 指向同一批提交时，两条都要报——兄弟之间不许互相遮蔽', async () => {
    const { repoPath, base } = await repository()
    await lane(repoPath, 'lane-e', 1)
    await git(repoPath, 'branch', 'lane-f', 'lane-e')

    expect(await orphanCount(repoPath, 'lane-e', base)).toBe(1)
    expect(await orphanCount(repoPath, 'lane-f', base)).toBe(1)
  }, 30000)

  it('base 名字不存在时读成 null，不是 0 —— 查不出来和查过了是相反的两件事', async () => {
    const { repoPath } = await repository()
    await lane(repoPath, 'lane-g', 1)
    expect(await orphanCount(repoPath, 'lane-g', 'no-such-base')).toBeNull()
  }, 30000)

  it('带斜杠的分支名照样数得对——fan-out 之外的分支常长这样', async () => {
    const { repoPath, base } = await repository()
    // 本来这条写的是 `-dash-lane`，想钉住 `--` 终止选项那件事。但 git 自己就不收以短横线开头的
    // 分支名（`git branch -- -dash-lane` → fatal: not a valid branch name），也就是说那种输入
    // 根本到不了我们这儿——为一个不可能的输入写断言，是拿一条永远绿的用例冒充守卫。
    // `feat/x` 是真会出现、且 ref 与路径两种解读都说得通的那种名字。
    await lane(repoPath, 'feat/x', 1)
    expect(await orphanCount(repoPath, 'feat/x', base)).toBe(1)
  }, 30000)
})

describe('parseOrphanCommitCount 只在真的数出来时才给数字', () => {
  it('非零退出一律 null', () => {
    expect(parseOrphanCommitCount('3\n', 1)).toBeNull()
    expect(parseOrphanCommitCount('', 128)).toBeNull()
  })

  it('读不懂的输出也是 null，不是 0', () => {
    expect(parseOrphanCommitCount('fatal: whatever\n', 0)).toBeNull()
    expect(parseOrphanCommitCount('', 0)).toBeNull()
  })

  it('数得出来就给数字', () => {
    expect(parseOrphanCommitCount('0\n', 0)).toBe(0)
    expect(parseOrphanCommitCount('  7  \n', 0)).toBe(7)
  })
})

describe('确认框里那句关于分支的话', () => {
  it('三种状态三句话，没有共用实词——措辞近似会吃掉分类', () => {
    const unchecked = branchRetentionNote('lane-a', null)
    const safe = branchRetentionNote('lane-a', 0)
    const risky = branchRetentionNote('lane-a', 3)

    // 判据不是「三句话不相等」（改一个标点就能骗过），而是三句话各自说出了只有它成立的那件事。
    expect(unchecked).toContain('could not be checked')
    expect(safe).toContain('already reachable elsewhere')
    expect(risky).toContain('exist nowhere else')

    // 反向：安全的那句绝不许出现警告用词，否则用户会对正常删除也犹豫，久了就全都点过去。
    expect(safe).not.toContain('nowhere else')
    expect(unchecked).not.toContain('already reachable')
  })

  it('有风险时说清数量和分支名——数量让人能判断，分支名是事后唯一的抓手', () => {
    // 断言**连着动词**一起截。上一版写的是 `toContain('1 commit that')`，在动词前一个词就停住了，
    // 于是 "1 commit that exist nowhere else" 这个主谓不一致从绿灯底下走了过去——一条恰好绕开了
    // 自己要抓的那个 bug 的断言。
    expect(branchRetentionNote('lane-x', 1)).toContain('1 commit that exists nowhere else')
    expect(branchRetentionNote('lane-x', 4)).toContain('4 commits that exist nowhere else')
    expect(branchRetentionNote('lane-x', 4)).toContain('lane-x')
  })
})
