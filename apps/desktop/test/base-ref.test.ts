import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import {
  FALLBACK_BASE_REF,
  orphanCountableRef,
  parseRemoteHead,
  remoteHeadArgs
} from '../src/shared/base-ref.js'
import { orphanCommitCountArgs, parseOrphanCommitCount } from '../src/shared/lane-orphan-commits.js'

// ---------------------------------------------------------------------------
// base 的判定，以及「猜来的 base 不许拿去数独有提交」这条规则。
//
// 后半用**真 git** 验，而且是这组用例的重点：规则的全部理由是「猜错时会少报」，而少报只有真 git
// 才演得出来——假 host 里我们让它返回几就是几，那样验的是我们自己的算术。
// ---------------------------------------------------------------------------

const host = new LocalExecutionHost()
const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function git(repoPath: string, ...args: string[]): Promise<void> {
  const result = await host.run('git', [
    '-C', repoPath,
    '-c', 'user.name=AgentMux Test',
    '-c', 'user.email=agentmux@example.invalid',
    ...args
  ])
  expect(result.exitCode, `git ${args.join(' ')} failed: ${result.stderr}`).toBe(0)
}

async function orphanCount(repoPath: string, branch: string, baseRef: string): Promise<number | null> {
  const result = await host.run('git', orphanCommitCountArgs({ repoPath, branch, baseRef }))
  return parseOrphanCommitCount(result.stdout, result.exitCode)
}

describe('base 是哪条分支，以及这个答案权不权威', () => {
  it('远端声明了默认分支时如实取用，并标成权威', () => {
    expect(parseRemoteHead('origin/develop\n', 0)).toEqual({ ref: 'develop', source: 'remote-head' })
  })

  it('带斜杠的分支名只切掉第一个 origin/——按最后一个切会得到一个"存在但不是它"的名字', () => {
    // 这一条不是凑数：`feat/x` 被砍成 `x` 之后，如果仓里恰好有个 `x` 分支，我们会拿一条真实存在
    // 却错误的分支去数独有提交——正是本模块要挡的那种"有名有实却是错的" base。
    expect(parseRemoteHead('origin/feat/x\n', 0)).toEqual({ ref: 'feat/x', source: 'remote-head' })
  })

  it('问不出来时退到猜测，并且标签必须说它是猜的', () => {
    expect(parseRemoteHead('', 128)).toEqual({ ref: FALLBACK_BASE_REF, source: 'fallback' })
    // 退出码 0 但输出为空也是没查到，不是"查到了一个空名字"。
    expect(parseRemoteHead('   \n', 0)).toEqual({ ref: FALLBACK_BASE_REF, source: 'fallback' })
  })

  it('实参问的是 origin/HEAD，且带仓路径', () => {
    expect(remoteHeadArgs('/repo')).toEqual([
      '-C', '/repo', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'
    ])
  })

  it('只有权威答案够格拿去数独有提交——且够格时连 ref 一起给出', () => {
    // 返回 ref 而不是 true：想拿到能数的 ref 只有这一条路，规则就不再依赖调用方自觉去问。
    expect(orphanCountableRef({ ref: 'develop', source: 'remote-head' })).toBe('develop')
    expect(orphanCountableRef({ ref: 'main', source: 'fallback' })).toBeNull()
  })
})

describe('为什么猜来的 base 不许用来数独有提交——两个方向都用真 git 演一遍', () => {
  /** 一个真 base 不叫 main 的仓：`develop` 已推远端，另有一条本地 `main`。 */
  async function repository(): Promise<{ repoPath: string }> {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-base-ref-'))
    roots.push(root)
    const repoPath = join(root, 'repo')
    const remotePath = join(root, 'origin.git')
    await host.run('git', ['init', '-q', '--bare', remotePath])
    await host.run('git', ['init', '-q', '-b', 'develop', repoPath])
    await git(repoPath, 'remote', 'add', 'origin', remotePath)
    await git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'base')
    await git(repoPath, 'push', '-q', 'origin', 'develop')
    return { repoPath }
  }

  it('猜的 base 过时时会多报——方向安全，多问一句而已', async () => {
    const { repoPath } = await repository()
    await git(repoPath, 'branch', 'main') // 停在旧点上，之后不再前进
    await git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'develop moves on')
    await git(repoPath, 'branch', 'lane')
    await git(repoPath, 'checkout', '-q', 'lane')
    await git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'lane work')

    expect(await orphanCount(repoPath, 'lane', 'develop'), '真 base 下的真实答案').toBe(1)
    expect(await orphanCount(repoPath, 'lane', 'main'), '猜过时的 base：多报').toBe(2)
  }, 30000)

  it('猜的 base 已经含有这条 lane 时会报 0——把"只活在本地"说成"删得放心"', async () => {
    const { repoPath } = await repository()
    await git(repoPath, 'branch', 'lane')
    await git(repoPath, 'checkout', '-q', 'lane')
    await git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'LANE UNIQUE WORK')
    // 有人在本地把 lane 并进了 main（或者直接从 lane 开的 main）。远端对此一无所知。
    await git(repoPath, 'checkout', '-q', '-b', 'main', 'lane')

    expect(await orphanCount(repoPath, 'lane', 'develop'), '真 base 下：这批提交确实只此一处').toBe(1)
    // 这就是整条规则的理由。
    expect(
      await orphanCount(repoPath, 'lane', 'main'),
      '猜的 base 含有这条 lane 时读出 0——而 0 在产品里的意思是"删得放心"'
    ).toBe(0)

    // 而"别处也有"是假的：拿得到这批提交的只有本地 ref，远端一条都没有。
    const remotes = await host.run('git', ['-C', repoPath, 'branch', '-r', '--contains', 'lane'])
    expect(remotes.stdout.trim(), '远端没有任何分支含有它').toBe('')

    // 所以规则落在这里：这种 base 根本不该被拿去数，函数连 ref 都不给。
    expect(orphanCountableRef({ ref: 'main', source: 'fallback' })).toBeNull()
  }, 30000)
})
