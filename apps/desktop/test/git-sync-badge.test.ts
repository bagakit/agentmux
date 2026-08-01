import { describe, expect, it } from 'vitest'
import { gitSyncBadge } from '../src/renderer/src/lib/git-sync-badge.js'

// ---------------------------------------------------------------------------
// 「领先/落后 upstream 多少」的显示分类。
//
// 这是 aheadBehind 从主进程一路铺到 contract、渲染层却零调用者那条能力的取值层
// （git-service.ts:545 → ipc.ts:291 → preload:76 → contracts.ts:921，renderer 侧 0 个调用点）。
//
// 五种状态刻意各有一个 kind，而不是让组件读 `facts.ahead > 0`：这个判定有五个出口，散在组件里
// 就意味着下一个消费者（状态栏、命令面板、push 按钮的可用性）各抄一份，而抄的人只会照顾自己
// 关心的那两种（本仓 duplicated-rule-defeats-the-fix 那一族）。
// ---------------------------------------------------------------------------
describe('gitSyncBadge 的五种状态', () => {
  it('没有 upstream 时不看 ahead/behind，且与「已同步」是两个 kind', () => {
    // 这一条是本文件的主判据。主进程那侧 @{push} 与 @{upstream} 都解析不出时**返回 0/0**
    // （git-service.ts 的 aheadBehind 里那句 early return），所以 0/0 有两种完全不同的来源：
    // 「没得比」和「比过了正好一样」。把 upstream 判据删掉、只看两个计数，两者就折成同一种显示——
    // 用户看到「已同步」，而实际上这个分支根本没推上去过。
    const noUpstream = gitSyncBadge({ upstream: null, ahead: 0, behind: 0 })
    const synced = gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 0, behind: 0 })

    expect(noUpstream.kind).toBe('no-upstream')
    expect(synced.kind).toBe('synced')
    expect(
      noUpstream.kind,
      '「没有 upstream」与「已同步」判成了同一种——没推上去过的分支会显示成已同步'
    ).not.toBe(synced.kind)
    // 说明文字也要分得开：两者 label 都是空串（没有数字可报），所以只有 title 承载区别。
    expect(
      noUpstream.title,
      '没有 upstream 的说明与已同步的说明一字不差，用户读不出区别'
    ).not.toBe(synced.title)
    expect(noUpstream.title).toContain('no upstream')
    expect(synced.title).toContain('Up to date')
  })

  it('只领先时报 ↑N，只落后时报 ↓N，两者不混', () => {
    // ahead 与 behind 对调是这段代码最容易犯且最难看出的错：数字仍然对，方向反了，于是用户
    // 以为要 pull 实际该 push。所以两条各自断言箭头方向。
    const ahead = gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 3, behind: 0 })
    expect(ahead.kind).toBe('ahead')
    expect(ahead.label, '领先却没画 ↑3').toBe('↑3')
    expect(ahead.title, '领先的说明该说 push').toContain('push')

    const behind = gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 0, behind: 2 })
    expect(behind.kind).toBe('behind')
    expect(behind.label, '落后却没画 ↓2').toBe('↓2')
    expect(behind.title, '落后的说明该说 pull').toContain('pull')

    // 对照：两者的 label 与 title 都必须不同。相同则说明方向判定退化成了「有差异」。
    expect(ahead.label, '领先与落后画成了同一个徽标').not.toBe(behind.label)
    expect(ahead.title, '领先与落后说的是同一句话').not.toBe(behind.title)
  })

  it('两侧都非零是 diverged，且两个数都要给出来', () => {
    // diverged 必须单列：它是 pull 会产生 merge/rebase 的那一种。若它被折进 ahead 或 behind，
    // 用户只看到一个数字，会以为一次 push 或一次 pull 就能收敛。
    const badge = gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 4, behind: 7 })
    expect(badge.kind).toBe('diverged')
    expect(badge.label, '分叉时漏了领先那一侧的数').toContain('↑4')
    expect(badge.label, '分叉时漏了落后那一侧的数').toContain('↓7')
    expect(badge.title).toContain('Diverged')
    // 对照：单侧非零不能也被判成 diverged，否则这个 kind 就没有区分力。
    expect(gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 4, behind: 0 }).kind)
      .not.toBe('diverged')
  })

  it('upstream 的 ref 名去掉 refs/ 前缀后才给人看，且两种前缀都要认', () => {
    // aheadBehind 走 `rev-parse --symbolic-full-name`，所以拿到的是完整 ref：远端 upstream 是
    // refs/remotes/origin/main，而**本地分支也能当 upstream**（git-service.ts 的注释明确说
    // @{upstream} 也覆盖 refs/heads/main 这种）。只剥远端那一种，本地 upstream 就会带着
    // refs/heads/ 出现在悬停说明里。
    expect(
      gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 1, behind: 0 }).title
    ).toContain('origin/main')
    expect(
      gitSyncBadge({ upstream: 'refs/heads/main', ahead: 1, behind: 0 }).title,
      '本地分支当 upstream 时 refs/heads/ 前缀没被剥掉'
    ).toContain('to main.')
    // 两种都不该把 refs/ 漏出来。
    for (const upstream of ['refs/remotes/origin/main', 'refs/heads/main']) {
      expect(
        gitSyncBadge({ upstream, ahead: 1, behind: 0 }).title,
        `${upstream} 的 refs/ 前缀漏进了给人看的说明`
      ).not.toContain('refs/')
    }
  })

  it('单数不写成复数：1 commit 而不是 1 commits', () => {
    expect(gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 1, behind: 0 }).title)
      .toContain('1 commit to')
    expect(gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 2, behind: 0 }).title)
      .toContain('2 commits to')
    expect(gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 0, behind: 1 }).title)
      .toContain('1 commit to')
  })

  it('负的计数进不了输出——每个分支只报它判为正的那一侧', () => {
    // 这一条钉的是「为什么不需要把负数夹回 0」。三个分支的判据全是 `> 0`，而每个分支只把判为正的
    // 那一侧写进 label / title，所以负的那一侧永远落在 false 一侧、永远不出现。
    //
    // 起初这里写的是「负数被夹回 0」并配了 Math.max：那个断言对夹取的在场与缺席**完全不可观测**
    // （删掉 Math.max 后 6 条全绿，探针证明 -1 不夹取也一样落到 synced，label 同为空串）。夹取因此
    // 是恒被蕴含的多余代码，已删；判据改成钉住这条性质本身——它才是让夹取多余的原因。
    for (const [ahead, behind] of [[-1, 0], [-1, 3], [3, -2], [-1, -1]] as const) {
      const badge = gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead, behind })
      expect(
        badge.label,
        `ahead=${ahead} behind=${behind} 的徽标漏出了负数：界面上会出现读不懂的 ↑-1`
      ).not.toMatch(/-\d/)
      expect(
        badge.title,
        `ahead=${ahead} behind=${behind} 的说明漏出了负数`
      ).not.toMatch(/-\d/)
    }
    // 前提自检：这批输入必须真的走到了不同分支，否则上面的循环只在 synced 上转了四圈。
    expect(
      gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: -1, behind: 3 }).kind,
      '负的 ahead 配正的 behind 没落到 behind 分支，这批输入覆盖不到「只报正的那一侧」'
    ).toBe('behind')
    expect(
      gitSyncBadge({ upstream: 'refs/remotes/origin/main', ahead: 3, behind: -2 }).kind
    ).toBe('ahead')
  })
})
