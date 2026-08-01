import type { SessionSnapshot } from '../../../shared/contracts'

export function sessionTabTooltip(
  session: Pick<SessionSnapshot, 'label' | 'id' | 'hostId' | 'workspacePath' | 'createdAt' | 'updatedAt'>,
  // The tab's shown name, when it differs from the Provider·Workspace label — a user rename, a single
  // Agent's own name, or a family name. The tooltip leads with what the user sees, then keeps the
  // low-frequency identity (id/host/cwd/times) below it. Absent falls back to session.label.
  displayName?: string,
  // 这张 Tab 里都有些什么（`tabRegionSummary`），只在种类多于一种时在场。它排在身份之上、名字之下：
  // 一张多 Region 的 Tab，"里面还有个浏览器"比 Session ID 更常被问到。
  regionSummary?: string | null
): string {
  return [
    displayName ?? session.label,
    ...(regionSummary ? [regionSummary] : []),
    `Session ID: ${session.id}`,
    `Host: ${session.hostId}`,
    // The Agent's working directory is Core's session.workspacePath — the cwd of the running process.
    // It is shown verbatim so a moved View never lets its host workspace's name stand in for the real
    // cwd: the tab keeps telling the truth about where the Agent actually works.
    `Working directory: ${session.workspacePath}`,
    `Started: ${new Date(session.createdAt).toLocaleString()}`,
    `Active: ${new Date(session.updatedAt).toLocaleString()}`
  ].join('\n')
}

/**
 * 没有 Session 的 Tab 的 tooltip——两个文件 Region 拼起来的 Tab 就一个 Session 都没有。
 *
 * 为什么不能让渲染现场写 `session ? sessionTabTooltip(...) : displayName`（它此前正是这么写的）：
 * 那样「这张 Tab 里都有些什么」只有带 Session 的 Tab 才说得出来，而**恰恰是没有 Session 的多 Region
 * Tab 最需要它**（文件 + 浏览器这种组合里没有任何 Provider 名可依）。两条路各写一半必然漂移，
 * 所以两条路都从这里取值，`regionSummary` 缺席时它自然退回只有名字。
 */
export function surfaceTabTooltip(displayName: string, regionSummary?: string | null): string {
  return regionSummary ? `${displayName}\n${regionSummary}` : displayName
}

export function canStopSessionRun(
  session: Pick<SessionSnapshot, 'processState'>
): boolean {
  return session.processState !== 'exited'
}
