import type { SessionStatus } from '../../../shared/contracts'
import {
  titleWorkbenchSurface,
  workbenchSurfaces,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'

/**
 * 一张 Tab 在标签上该画哪几个标记。
 *
 * 为什么需要它：一张 Tab 可以含多个 Region（分屏），而标签此前只按 `titleWorkbenchSurface` 画**一个**
 * 图标——于是「这张 Tab 里还开着一个终端和一个浏览器」在标签上完全看不出来。
 *
 * 为什么是**按画出来的样子去重**、而不是每个 Region 一个图标：设计 SSOT
 * `docs/design/agentmux-surface-density.md` 有一条直接管这件事——「一列全同的图标不是信息，是宽度
 * 开销」，图标的价值在于**区分**。三个终端 Region 堆三个一样的终端图标不携带任何信息，只挤掉标题的
 * 可读宽度。真正有区分度的是种类构成：「这里有终端 + 浏览器」。
 */
export type WorkbenchTabMark =
  | { kind: 'agent'; providerId: string; status: SessionStatus; regionId: string }
  | { kind: 'terminal'; regionId: string }
  | { kind: 'file'; regionId: string }
  | { kind: 'launcher'; regionId: string }
  | { kind: 'browser'; regionId: string }

/**
 * 一个 Region 解析出来的 Agent 事实，或 null 表示「这个 Region 上没有 Agent」。
 *
 * `status` 直接用 Session 自己的 `SessionStatus`，不另抄一份"只要 state 和 source"的窄类型：状态点由
 * `StatusDot` 画，它要的就是这个形状；手抄一份平行类型只会在下次给状态加字段时漂移。注意 appearance
 * 只取其中的 `state`——`source` 只进 `StatusDot` 的 tooltip，是**指过去才看得到**的文字，两个 state 相同
 * 而 source 不同的状态点并排画出来逐像素相同，所以它参与渲染但不参与去重。
 *
 * 为什么由调用方解析、而不是这里自己按 `surface.kind === 'agent'` 判：**画不画 Agent 标记取决于
 * session 解析出来是不是 Agent，不是 surface 的 kind**——`WorkspaceWorkbench` 里那条链就是这么写的
 * （`surface.kind === 'agent' || 'terminal'` 之后还要再看 `session?.kind === 'agent'`），因为一个
 * kind 是 terminal 的 Region 拿到的 session 可能是 Agent，而一个 kind 是 agent 的 Region 在 session
 * 还没到时什么 Agent 事实都没有。
 *
 * 若这里自己按 kind 猜，去重键与真正画出来的东西就是两个判断，必然漂移：两个 agent Region 的 session
 * 都还没解析出来时，它们都画成同一个终端图标（逐像素相同），却会被按 sessionId 判成"可区分"而堆两个。
 */
export type TabMarkAgentFacts = { providerId: string; status: SessionStatus }

/**
 * 这个 Region 上的 Agent 是谁、什么状态——`workbenchTabMarks` 唯一的取值入口。
 *
 * 为什么必须是这里的具名函数、而不是渲染现场的内联回调：`WorkspaceWorkbench` 那个文件在 node 里
 * import 不了（它经 `api.ts` 依赖 vite define `__AGENTMUX_WEB_PREVIEW__`），所以写在那里的任何取值判断
 * **无法被任何测试执行到**。实测把内联回调的第一行改成 `return null`——标签上所有 Agent 标记退化成终端
 * 图标，用户再也分不清 codex/claude，也看不到状态点——而 20 条标记测试照旧全绿。
 *
 * 这是「壳搬出去了，取值判断还留在测不到的地方」那半个修复的另一半：`WorkbenchTabMarks` 负责画，
 * `workbenchTabMarks` 负责决定画哪几个，而「谁是 Agent」这个判断在这里，三者都能被测试质询。
 *
 * 判据本身：**看解析出来的 session 是不是 agent，不看 surface.kind**（理由见 `TabMarkAgentFacts` 的注释）。
 * 只有带 `sessionId` 的两种 surface 才可能解析出 session，其余 kind 一律没有 Agent 事实。
 */
export function tabMarkAgentFactsFor(
  sessions: readonly TabMarkSession[]
): (surface: WorkbenchSurface) => TabMarkAgentFacts | null {
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  return (surface) => {
    if (surface.kind !== 'agent' && surface.kind !== 'terminal') return null
    const session = sessionById.get(surface.sessionId)
    if (session?.kind !== 'agent') return null
    return { providerId: session.providerId, status: session.status }
  }
}

/**
 * 取值只要 Session 的这几个字段。
 *
 * 不直接收 `SessionSnapshot`：那个类型带着 capabilities、launchOptions、turnUsage 等几十个与「标签上画
 * 什么」无关的字段，收窄到真正读的那几个，测试就不必为了调这个函数去伪造一整份 Session 快照。
 *
 * 写成联合而不是 `providerId?: string`：只有 agent 那支有 Provider，`kind === 'agent'` 才收窄出
 * `providerId`。将来 `SessionSnapshot` 多一支 kind 时，调用点会因为类型不匹配而红——那是对的，得有人
 * 决定新那支在标签上算不算 Agent，而不是让它静默走进 null 分支。
 */
export type TabMarkSession =
  | { id: string; kind: 'agent'; providerId: string; status: SessionStatus }
  | { id: string; kind: 'terminal'; status: SessionStatus }

/**
 * 标签上最多画几个标记。
 *
 * 超出的部分不画省略号也不画计数：标签本身宽度极紧（`workbench.css` 的 `.workbench-tab`），再塞一个
 * 「+2」就把标题挤到不可读——而标题是这个控件的主体信息。三个已经足够表达「这张 Tab 不止一样东西」，
 * 精确构成由 Tab 内的分屏本身回答。
 */
export const WORKBENCH_TAB_MARK_LIMIT = 3

/**
 * 算出一张 Tab 的标记序列。
 *
 * `agentFactsFor` 回答"这个 Region 上的 Agent 是谁、什么状态"；返回 null 即这个 Region 上没有 Agent，
 * 于是 agent/terminal 两种 Region 都退化成同一个终端标记——和渲染现场的行为一致。
 *
 * 顺序：标题那个 Region 恒在最前。它是这张 Tab 的身份，不能因为 `regions` 的迭代序而漂到后面，更不能
 * 因为超出上限而被截掉——那样标签上画的第一个图标就不是这张 Tab 自己了。
 */
export function workbenchTabMarks(
  tab: WorkbenchTab,
  agentFactsFor: (surface: WorkbenchSurface) => TabMarkAgentFacts | null
): WorkbenchTabMark[] {
  const title = titleWorkbenchSurface(tab)
  const ordered = [
    title,
    // 按 regionId 排除，而不是按对象引用：regionId 才是 Region 的身份，引用相等只是当下的实现巧合。
    ...workbenchSurfaces(tab).filter((surface) => surface.regionId !== title.regionId)
  ]
  const marks: WorkbenchTabMark[] = []
  const seen = new Set<string>()
  for (const surface of ordered) {
    const mark = surfaceMark(surface, agentFactsFor(surface))
    const key = markAppearance(mark)
    if (seen.has(key)) continue
    seen.add(key)
    marks.push(mark)
    if (marks.length >= WORKBENCH_TAB_MARK_LIMIT) break
  }
  return marks
}

/**
 * 这个标记画出来长什么样——两个标记的 appearance 相同，就意味着并排画出来无法区分，第二个只是宽度开销。
 *
 * 它同时是去重键。把「视觉是否可区分」和「要不要去重」收成同一个取值，是为了让两者不可能漂移：想让
 * 某一类不再去重，唯一的办法是让它的 appearance 真的因 Region 而异，而那正意味着它画出来真的不一样。
 *
 * regionId 一律不进 appearance：它逐 Region 必然不同，掺进来会让每个标记都"看起来不一样"，去重彻底失效。
 */
export function markAppearance(mark: WorkbenchTabMark): string {
  // agent 标记画的是 Provider 图标 + 状态点，所以这两样都进 appearance：换 Provider 或换状态都是
  // 肉眼能分辨的差别。其余每一类都只画一个固定图标，kind 本身就是它的全部外观。
  return mark.kind === 'agent' ? `agent:${mark.providerId}:${mark.status.state}` : mark.kind
}

function surfaceMark(
  surface: WorkbenchSurface,
  agent: TabMarkAgentFacts | null
): WorkbenchTabMark {
  // Agent 事实在场就画 Agent 标记，与 surface.kind 无关——这正是渲染现场的判据。
  if (agent) {
    return {
      kind: 'agent',
      providerId: agent.providerId,
      status: agent.status,
      regionId: surface.regionId
    }
  }
  switch (surface.kind) {
    // Agent 事实缺席的 agent Region 与终端 Region 画的是同一个终端图标，所以标记也是同一种。
    case 'agent':
    case 'terminal':
      return { kind: 'terminal', regionId: surface.regionId }
    case 'file':
      return { kind: 'file', regionId: surface.regionId }
    case 'launcher':
      return { kind: 'launcher', regionId: surface.regionId }
    case 'browser':
      return { kind: 'browser', regionId: surface.regionId }
  }
}

/**
 * 一张 Tab 里都有些什么——给 tooltip 的人话，`null` 表示这件事不必说。
 *
 * 为什么必须有它：`workbenchTabMarks` 在 `WORKBENCH_TAB_MARK_LIMIT` 处截断，超出的种类**一声不响
 * 地消失**。标签上不画 `+N` 是对的（标签宽度极紧，一个角标就把标题挤到不可读），但"不画"不等于
 * "不说"——本仓自家的头像簇规矩就是这么定的：「超过可容纳枚数折成 `+N`，全名进 tooltip」
 * （`docs/design/agentmux-surface-density.md` 的 Scratch Topic Row）。标记簇此前只做了截断那一半，
 * 折掉的东西在界面上没有任何痕迹，与那条规矩正好相反。
 *
 * 所以这里从**未截断的全部 Region** 算，不从 `marks` 算：拿已经截断的结果去描述被截断掉的东西是
 * 循环的，第四种 Region 照旧说不出来。
 *
 * 返回 `null` 而不是空串或单种类的名字，为的是另一条同样来自 SSOT 的规矩——**不重复呈现同一事实**。
 * 一张单 Region 的 Tab（绝大多数）标签上已经画着那一个图标，tooltip 再补一行「Regions: Terminal」
 * 是同一件事占两处；只有一个种类时也同理（三个终端 Region 画一个终端图标，说"Terminal"没有增量）。
 * 只有当种类真的多于一种、标签因此无法完整表达时，这句话才携带信息。
 */
export function tabRegionSummary(
  tab: WorkbenchTab,
  agentFactsFor: (surface: WorkbenchSurface) => TabMarkAgentFacts | null
): string | null {
  const labels: string[] = []
  for (const surface of workbenchSurfaces(tab)) {
    const label = markLabel(surfaceMark(surface, agentFactsFor(surface)))
    // 按人话去重，而不是按种类：两个 codex Agent 在 tooltip 里也读作同一个词，列两遍是噪音。
    // 这与 `markAppearance` 是两个不同的判据（那个问"画出来一样吗"，这个问"说出来一样吗"），
    // 今天两者都把同 Provider 同类折成一个，但状态不进人话——状态点画得出来，写进这句话就成了
    // 一句会过期的描述。
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.length > 1 ? `Regions: ${labels.join(', ')}` : null
}

/**
 * 一个标记在 tooltip 里叫什么。
 *
 * Agent 那支带上 Provider 名——「这张 Tab 里还有一个 claude」正是被折掉时最可惜的那条信息。
 * 其余每类只有一个固定图标，种类名就是它的全部。
 */
function markLabel(mark: WorkbenchTabMark): string {
  switch (mark.kind) {
    case 'agent':
      return mark.providerId
    case 'terminal':
      return 'Terminal'
    case 'file':
      return 'File'
    case 'launcher':
      return 'New tab'
    case 'browser':
      return 'Browser'
    default: {
      // 与渲染那边同一个理由：本仓没开 noImplicitReturns，少一支时 tsc 只是把返回类型放宽成含
      // undefined。这一句才让新增种类在这里也编译不过——否则新种类会在 tooltip 里静默变成 undefined。
      const unhandled: never = mark
      throw new Error(`Unhandled workbench tab mark: ${JSON.stringify(unhandled)}`)
    }
  }
}
