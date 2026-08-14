import type { SessionSnapshot } from '../../../shared/contracts'
import { findWorkbenchRegion, workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import type { StepOutcome } from './service-window-notice'

/**
 * 异步创建（open.agent / open.terminal）的**落点回执**——在完成时对着**当前**布局重新解析，绝不回放
 * 计划里的坐标。启动是异步的：从 planControlOpen 造出 `plan.tabId` 到 launch 完成之间有一段网络窗口
 * （远端可达 15s），用户可能把那一格搬走、把它所在的 Tab 关掉或重排。此刻若照 `plan.tabId` 生成回执，
 * 就把旧坐标交回给发起方；若照计划把布局写回去，就覆盖掉用户刚摆好的新布局。
 *
 * 这是**唯一一处** re-resolution：`open.agent` 与 `open.terminal` 两条完成路径都调用它。两条路本是同一个
 * 判断的两份拷贝——commit 589ab7bf 只补了 agent 那份（改回 `committedOwner.tab.id`），terminal 那份仍在
 * 返回 `plan.tabId`（本仓库反复被这种 two-write-sites 咬过：见 memory `two-write-sites-need-one-projection`）。
 * 收成一处纯函数，两条路共用同一个「实际落点 / 已错位」的判定，拷贝无从漂移。
 *
 * 判据是 regionId 的当前归属：区域还在、种类没变、且承载的仍是**这一次**启动的 sessionId（不是那个 id
 * 被后续复用后的别的面）→ 落点即它当前所在 Tab；否则「已错位」——绝不复活计划。
 */
export type SpatialCommit =
  | { kind: 'landed'; tabId: string }
  | { kind: 'displaced' }

export function resolveSpatialCommit(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  regionId: string,
  want: { kind: 'agent' | 'terminal'; sessionId: string }
): SpatialCommit {
  const owner = findWorkbenchRegion(tabs, regionId)
  if (!owner || owner.surface.kind !== want.kind) return { kind: 'displaced' }
  // 身份闸门：这一格现在承载的必须还是**这次**启动的 session。不判 sessionId 的话，一格被关掉又立刻被
  // 另一次创建复用同一个 regionId 时（regionId 会被回收），会把别人的落点当成自己的回执交出去。
  if (!isSessionSurface(owner.surface) || owner.surface.sessionId !== want.sessionId) {
    return { kind: 'displaced' }
  }
  return { kind: 'landed', tabId: owner.tab.id }
}

/**
 * 一条「已健康启动、但布局落点没了」的持续告示所需的数据。Agent 进程是好的、还在跑、仍在 session 列表里
 * 可被发现——缺的只是它没落在用户要的地方。
 */
export type DisplacedAgentNotice = { agentSessionId: string; label: string }

/**
 * 从 (sessions, tabs, 被记为错位的 id) 派生出**此刻仍成立**的持续告示。这是服务窗那套「随条件消失而非
 * 随点关闭消失」模型的判定层（见 service-window-notice.ts）：store 只记「启动完成时这一格错位了」这个
 * 事实，是否还要显示由这里对当前状态重新判定——
 *   - 该 agent 又被重新打开、重新拥有一格 → 从告示里消失（自愈）。
 *   - 该 agent 的 session 已经结束 → 从告示里消失（无从再发现，也无从再安放）。
 * 因此 store 侧那份 id 列表即使留有陈旧项也无害：这里按活着的 session 与当前布局过滤，死项渲染不出东西。
 *
 * 「仍可发现」与「持续告示」是两件事：发现靠 session 还在 `sessions` 里（进程没被杀），告示靠这里判出
 * 「活着但没有落点」。一个 agent 只有同时满足这两条才进入告示——被用户主动后台化（关掉视图但保留进程）
 * 的 agent 没有被记为错位，不会误报。
 */
export function selectDisplacedAgentNotices(
  sessions: readonly SessionSnapshot[],
  tabs: Readonly<Record<string, WorkbenchTab>>,
  displacedAgentSessionIds: readonly string[]
): DisplacedAgentNotice[] {
  const placedSessionIds = new Set(
    Object.values(tabs).flatMap((tab) =>
      workbenchSurfaces(tab).flatMap((surface) => (isSessionSurface(surface) ? [surface.sessionId] : []))
    )
  )
  const seen = new Set<string>()
  const notices: DisplacedAgentNotice[] = []
  for (const agentSessionId of displacedAgentSessionIds) {
    if (seen.has(agentSessionId)) continue
    seen.add(agentSessionId)
    // 又拿回了一格 → 已自愈，不再告示。
    if (placedSessionIds.has(agentSessionId)) continue
    // session 已经不在 → 无从发现也无从安放，告示无意义。
    const session = sessions.find((item) => item.id === agentSessionId)
    if (!session || session.kind !== 'agent') continue
    notices.push({ agentSessionId, label: session.label })
  }
  return notices
}

/**
 * 告示文案的 SSOT。复用服务窗已有的三段式（哪一步没走通 / 现在按什么状态在跑 / 怎么恢复）与它的分类器：
 * agent 存活判定恒为 `alive`——进程好好的，坏的只是我们的安放这一步，所以归到「流程降级：放行 + 提醒」，
 * 绝不阻断。文案不写成否定式，直接说进程还在、去哪儿找回它。
 */
export function displacedAgentStepOutcome(label: string): StepOutcome {
  return {
    completed: false,
    agentViability: 'alive',
    step: {
      label: `Placing the “${label}” Agent`,
      degradedMode: 'The Agent started and is still running — it just isn’t shown where you asked',
      restore: 'Open it again from the session list to give it a place'
    }
  }
}
