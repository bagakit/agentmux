import type { GitAheadBehind } from '../../../shared/contracts'

/**
 * 「这个分支相对 upstream 领先/落后多少」在界面上长什么样。
 *
 * `kind` 是给读的人的分类，五种状态刻意各有一个名字而不是让调用方去比数字：
 *   - `no-upstream`：这个分支还没有 upstream，`ahead`/`behind` 都是 0 但那两个 0 **没有意义**。
 *     与 `synced` 分开是必须的——「没得比」和「比过了正好一样」对用户是两件事（前者的下一步是
 *     推一个新分支上去，后者的下一步是什么都不用做）。
 *   - `synced`：有 upstream 且两侧都是 0。
 *   - `ahead` / `behind`：只有一侧非零。
 *   - `diverged`：两侧都非零。这一种必须单列：它是 pull 会产生 merge/rebase 的那一种，
 *     显示上要同时给出两个数，不能只报一个。
 *
 * 为什么是纯函数、而不是在组件里直接读 `facts.ahead > 0`：这个分类有五个出口，而组件里内联判
 * 就意味着下一个消费者（状态栏、命令面板、push 按钮的可用性）各抄一份，抄的人只会照顾自己关心
 * 的那两种（本仓 duplicated-rule-defeats-the-fix 那一族）。这里判一次，`label` 与 `title` 也从
 * 同一次判定出来，界面上的字与徽标不可能各说一套。
 */
export type GitSyncBadge = {
  kind: 'no-upstream' | 'synced' | 'ahead' | 'behind' | 'diverged'
  /** 徽标上的短文本。`no-upstream` / `synced` 没有数字可报，给空串——调用方据 kind 决定画不画。 */
  label: string
  /** 悬停说明。始终是完整句子，且 upstream 在场时**一定**带上它的 ref 名。 */
  title: string
}

/** upstream 的 ref 名去掉 `refs/remotes/` / `refs/heads/` 前缀后给人看的那份。 */
function shortUpstream(upstream: string): string {
  return upstream.replace(/^refs\/(remotes|heads)\//, '')
}

export function gitSyncBadge(facts: GitAheadBehind): GitSyncBadge {
  // upstream 缺席时**不看** ahead/behind：主进程那侧无 upstream 时返回的 0/0 是占位，不是测量结果
  // （git-service.ts 的 aheadBehind 在 @{push} 与 @{upstream} 都解析不出时直接返回 0/0）。
  // 先判它，就不会把「没得比」画成「已同步」。
  if (facts.upstream === null) {
    return {
      kind: 'no-upstream',
      label: '',
      title: 'This branch has no upstream yet — nothing to compare against.'
    }
  }
  const upstream = shortUpstream(facts.upstream)
  // 三个分支的判据全是 `> 0`，而每个分支只把它判为正的那一侧写进 label / title。于是一个负的
  // 计数永远落在被判为 false 的那一侧，永远进不了输出——**不需要**把它夹回 0（实测：加一层
  // Math.max(0, …) 对全部四种正负组合都不改变结果，是恒被蕴含的多余代码）。
  const { ahead, behind } = facts
  if (ahead > 0 && behind > 0) {
    return {
      kind: 'diverged',
      label: `↑${ahead} ↓${behind}`,
      title: `Diverged from ${upstream}: ${ahead} ahead, ${behind} behind.`
    }
  }
  if (ahead > 0) {
    return {
      kind: 'ahead',
      label: `↑${ahead}`,
      title: `${ahead} commit${ahead === 1 ? '' : 's'} to push to ${upstream}.`
    }
  }
  if (behind > 0) {
    return {
      kind: 'behind',
      label: `↓${behind}`,
      title: `${behind} commit${behind === 1 ? '' : 's'} to pull from ${upstream}.`
    }
  }
  return { kind: 'synced', label: '', title: `Up to date with ${upstream}.` }
}
