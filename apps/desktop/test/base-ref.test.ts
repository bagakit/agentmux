import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import {
  FALLBACK_BASE_REF,
  orphanCountableRef,
  parseRemoteHead,
  remoteHeadArgs,
  type CountableBaseRef
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

/**
 * 故意去数一个**规则不许数**的 base，好把「不许」的那个代价量出来。
 *
 * 生产里这条路走不通：`orphanCommitCountArgs` 只收 `CountableBaseRef`，而猜来的 base 铸不出。这里
 * 之所以还要铸一个出来，是因为规则的全部理由就是「真去数会读出 0」——不实际数一次，那张表就只是
 * 一句断言。所以这个 helper 的名字就叫 counterfactual：它是在演一件**已经被类型系统挡掉**的事。
 *
 * 传进 `remoteRef` 位（可数的就是那一半），于是这个 helper 真正的意思是「不管够不够格，就拿这个
 * 字符串去数」——正是反事实要的。
 */
function counterfactualRef(ref: string): CountableBaseRef {
  const minted = orphanCountableRef({ ref, remoteRef: ref, source: 'remote-head' })
  if (minted === null) throw new Error(`铸不出可数 ref: ${ref}`)
  return minted
}

async function orphanCount(repoPath: string, branch: string, baseRef: string): Promise<number | null> {
  const result = await host.run(
    'git',
    orphanCommitCountArgs({ repoPath, branch, baseRef: counterfactualRef(baseRef) })
  )
  return parseOrphanCommitCount(result.stdout, result.exitCode)
}

describe('base 是哪条分支，以及这个答案权不权威', () => {
  it('远端声明了默认分支时如实取用，并标成权威——两个拼法都留着', () => {
    // `ref` 给开 PR（`gh pr create --base develop`），`remoteRef` 给数独有提交（本地解析得开的
    // revision）。少留一个，另一条路就得自己拼一次——而这个模块顶部记着，自己拼正是那个 bug。
    expect(parseRemoteHead('origin/develop\n', 0)).toEqual({
      ref: 'develop',
      remoteRef: 'origin/develop',
      source: 'remote-head'
    })
  })

  it('带斜杠的分支名只切掉第一个 origin/——按最后一个切会得到一个"存在但不是它"的名字', () => {
    // 这一条不是凑数：`feat/x` 被砍成 `x` 之后，如果仓里恰好有个 `x` 分支，我们会拿一条真实存在
    // 却错误的分支去数独有提交——正是本模块要挡的那种"有名有实却是错的" base。
    expect(parseRemoteHead('origin/feat/x\n', 0)).toEqual({
      ref: 'feat/x',
      remoteRef: 'origin/feat/x',
      source: 'remote-head'
    })
  })

  it('问不出来时退到猜测，并且标签必须说它是猜的；猜测档不给 remoteRef', () => {
    // `remoteRef: null` 不是省事：`origin/` 这个前缀是从远端那句原话里**读**出来的。猜的时候没有
    // 原话，拼一个 `origin/main` 出来就是在编一个可能指向别处（远端叫 upstream）的 ref。
    expect(parseRemoteHead('', 128)).toEqual({ ref: FALLBACK_BASE_REF, remoteRef: null, source: 'fallback' })
    // 退出码 0 但输出为空也是没查到，不是"查到了一个空名字"。
    expect(parseRemoteHead('   \n', 0)).toEqual({ ref: FALLBACK_BASE_REF, remoteRef: null, source: 'fallback' })
  })

  it('实参问的是 origin/HEAD，且带仓路径', () => {
    expect(remoteHeadArgs('/repo')).toEqual([
      '-C', '/repo', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'
    ])
  })

  it('只有权威答案够格拿去数独有提交——且够格时给的是本地解析得开的那个 ref', () => {
    // 返回 ref 而不是 true：想拿到能数的 ref 只有这一条路，规则就不再依赖调用方自觉去问。
    // 给的是 `remoteRef` 而不是 `ref`：后者是开 PR 的拼法，拿去 rev-list 就成了「本地有没有一条
    // 叫 develop 的分支」——下面那组真 git 用例量出了这个差别。
    expect(
      orphanCountableRef({ ref: 'develop', remoteRef: 'origin/develop', source: 'remote-head' })
    ).toBe('origin/develop')
    expect(orphanCountableRef({ ref: 'main', remoteRef: null, source: 'fallback' })).toBeNull()
    // 权威档但没有 remoteRef（本不该出现的组合）也只能是"数不了"，不许退回去用分支名——那正是
    // 这次修的那条路。
    expect(orphanCountableRef({ ref: 'develop', remoteRef: null, source: 'remote-head' })).toBeNull()
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
    expect(orphanCountableRef({ ref: 'main', remoteRef: null, source: 'fallback' })).toBeNull()
  }, 30000)
})

describe('权威 base 也得用本地解析得开的那个拼法——否则警告在 fan-out 场景里静默消失', () => {
  /**
   * fan-out 的常态形状：签出一条 **feature 分支**的 clone，再在上面开 lane。
   *
   * 关键是两件事同时成立——`origin/HEAD` 在（于是走权威档、警告本该生效），而本地**没有** `main`
   * （clone 只建了被签出那条的本地分支）。`git clone --branch feature-x` 就是这个形状，而它正是
   * 这个产品的主线玩法，不是边角。
   */
  async function featureBranchClone(): Promise<{ repoPath: string }> {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-base-ref-remote-'))
    roots.push(root)
    const remotePath = join(root, 'origin.git')
    const upstreamPath = join(root, 'upstream')
    const repoPath = join(root, 'repo')

    await host.run('git', ['init', '-q', '--bare', remotePath])
    await host.run('git', ['init', '-q', '-b', 'main', upstreamPath])
    await git(upstreamPath, 'remote', 'add', 'origin', remotePath)
    await git(upstreamPath, 'commit', '-q', '--allow-empty', '-m', 'base')
    await git(upstreamPath, 'push', '-q', 'origin', 'main')
    await git(upstreamPath, 'checkout', '-q', '-b', 'feature-x')
    await git(upstreamPath, 'commit', '-q', '--allow-empty', '-m', 'feature work')
    await git(upstreamPath, 'push', '-q', 'origin', 'feature-x')
    // 裸仓的 HEAD 指向 main，clone 才会写出 refs/remotes/origin/HEAD。
    await git(remotePath, 'symbolic-ref', 'HEAD', 'refs/heads/main')

    await host.run('git', ['clone', '-q', '--branch', 'feature-x', remotePath, repoPath])
    await git(repoPath, 'checkout', '-q', '-b', 'lane')
    await git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'LANE UNIQUE WORK')
    return { repoPath }
  }

  it('前提自检：origin/HEAD 在（走权威档），而本地没有 main', async () => {
    // 少了这条，下面两条就可能是在另一个形状上全绿——比如 clone 恰好建了本地 main，那时两个拼法
    // 都能解析，差别消失，而用例名还在说它守住了。
    const { repoPath } = await featureBranchClone()

    const head = await host.run('git', remoteHeadArgs(repoPath))
    expect(parseRemoteHead(head.stdout, head.exitCode)).toEqual({
      ref: 'main',
      remoteRef: 'origin/main',
      source: 'remote-head'
    })

    const locals = await host.run('git', ['-C', repoPath, 'branch', '--format=%(refname:short)'])
    expect(locals.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort()).toEqual([
      'feature-x',
      'lane'
    ])
  }, 30000)

  it('分支名那半拿去数会 fatal，远端跟踪那半数得出——这就是这次改动的全部差别', async () => {
    const { repoPath } = await featureBranchClone()

    // 修之前给出去的就是这一半。git 认不出这个 revision。
    const byBranchName = await host.run(
      'git',
      orphanCommitCountArgs({ repoPath, branch: 'lane', baseRef: counterfactualRef('main') })
    )
    expect(byBranchName.exitCode, '本地没有 main，拿分支名去数必然 fatal').toBe(128)
    expect(parseOrphanCommitCount(byBranchName.stdout, byBranchName.exitCode)).toBeNull()

    // 修之后给出去的这一半，答得出，而且答案是对的：这条 lane 上确实有一条哪里都没有的提交。
    expect(await orphanCount(repoPath, 'lane', 'origin/main')).toBe(1)
  }, 30000)

  it('端到端：orphanCountableRef 交出来的那个 ref，真的数得出来', async () => {
    // 上一条证的是"两个字符串表现不同"，这一条证的是**生产真的挑了对的那个**。少了它，
    // `orphanCountableRef` 改回给 `ref` 时上一条仍然全绿——它自己喂的是写死的字符串。
    const { repoPath } = await featureBranchClone()

    const head = await host.run('git', remoteHeadArgs(repoPath))
    const countable = orphanCountableRef(parseRemoteHead(head.stdout, head.exitCode))
    expect(countable, '权威档必须铸得出可数 ref').not.toBeNull()

    const result = await host.run(
      'git',
      orphanCommitCountArgs({ repoPath, branch: 'lane', baseRef: countable! })
    )
    expect(
      parseOrphanCommitCount(result.stdout, result.exitCode),
      '这条 lane 有一条只活在本地的提交，警告必须说得出来——读成 null 就是那句话静默消失了'
    ).toBe(1)
  }, 30000)
})
