import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState, type NeedsYouState } from './attention-vocabulary'

// Which state change is worth interrupting a person over.
//
// This is the one place that answers it. Notification, row rollup, and the roster all read this
// decision instead of each re-deriving "what counts as finished" from a status field — three surfaces
// guessing separately is how they end up disagreeing about the same Agent.
//
// It is deliberately pure: statuses in, verdict out. No Store, no Electron, no provider branching, and
// nothing inferred from terminal bytes. That keeps the hard part — which is the policy, not the
// plumbing — testable without a window.

export type AttentionCategory = 'done' | 'needs-you' | 'error'

export type AttentionEvent = {
  category: AttentionCategory
  sessionId: string
  // Carried through so a notification can name the Agent without a second lookup, and so the caller
  // never has to re-resolve which Session this was about.
  label: string
  observedAt: number
}

// What the caller must tell us about what the user can currently see. A notification for something
// happening in front of the user is noise, so visibility is part of the decision, not an afterthought
// bolted on at the call site.
export type AttentionVisibility = {
  // Whether the AgentMux window itself has OS focus.
  windowFocused: boolean
  // Whether this Session's Region is currently on screen in that window. A Session in a collapsed
  // pane or a background tab group is NOT visible even when the window is focused.
  sessionVisible: boolean
}

/**
 * Decide whether a single Agent's state change should interrupt the user.
 *
 * Returns the event to raise, or null to stay quiet. Quiet is the default: this only speaks up for a
 * genuine transition into a category worth a person's attention, and only when they are not already
 * looking at it.
 */
export function attentionEventFor(input: {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  // The state this Session was last known to be in, or null when it is being seen for the first time.
  previousState: AgentDisplayState | null
  visibility: AttentionVisibility
}): AttentionEvent | null {
  const { session, previousState, visibility } = input
  const next = session.status.state

  // A repeat report of the same state is not a transition. Providers re-announce status, and a hook
  // can deliver the same fact twice, so without this the user gets notified again for nothing.
  if (previousState === next) return null

  // First sight is not a transition either. Attaching to a window that already holds finished Agents
  // must not fire a burst of notifications for work that completed before the app was even open —
  // that is startup noise, and it trains people to ignore the channel.
  if (previousState === null) return null

  const category = categoryFor(next)
  if (!category) return null

  // Do not interrupt someone with something they are already watching. The status dot and the Activity
  // view are already telling them; a system notification on top of that is pure duplication.
  if (visibility.windowFocused && visibility.sessionVisible) return null

  return {
    category,
    sessionId: session.id,
    label: session.label,
    observedAt: session.status.observedAt
  }
}

/**
 * The attention category a state belongs to, or null when the state is not worth interrupting over.
 *
 * The needs-you half comes from {@link isNeedsYouState} — the one table every attention surface reads —
 * rather than being spelled out again here. `disconnected` is false there on purpose: a dropped link is
 * not a request for attention. It has its own neutral treatment in the shared status vocabulary
 * precisely so amber can mean "needs you" and nothing else — raising a notification for it would undo
 * that distinction.
 *
 * 穷举、无 default，和它下面三个兄弟（attentionSortClass / sessionBoardColumn / statusLabel）同一个形状。
 * 此前它是一条 if 链、以 `return null` 收尾，于是四个状态映射里**只有它**对第十个状态静默：新状态直接
 * 落到那个兜底的 null，而 12 个生产消费者一律把 null 读成「没什么可看的」——不通知、行无强调、名册与
 * fan-out 的 attention 为空、卡片无边框、头像无标记。
 *
 * 「安静是默认」（见 attentionEventFor）这条规则没有变，五个 null 分支依旧返回 null；变的是**谁来做
 * 这个决定**。落到 null 现在必须是有人写下的那一行，而不是忘了写的那一行。第十个状态那天，这里和
 * 另外三处一起响亮地要求做决定：返回类型含 null 不影响穷举检查——漏一支得到的是隐式 undefined，而
 * `AttentionCategory | null` 收不下它，tsc 报 TS2366（实测过，别再为此套一层 'none' 哨兵）。
 */
export function categoryFor(state: AgentDisplayState): AttentionCategory | null {
  if (isNeedsYouState(state)) return 'needs-you'
  switch (state) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    // 以下五个刻意不进任何注意力档：starting/running/working 是「在跑」，本来就不该打扰人；
    // disconnected 见上（掉线不是请求）；exited 是进程终结这一生命周期事实而不是一个结果——
    // 「完成了一轮」只有 done 一个状态在说，而进程走了这件事，标签页与 Board 已经在画了。
    case 'starting':
    case 'running':
    case 'working':
    case 'disconnected':
    case 'exited':
      return null
  }
}

/**
 * The `data-attention` value a state earns, or null for no accent at all.
 *
 * Not every attention category gets colour. `done` is worth a notification but not an accent: amber and
 * red are for "you are the blocker" and "this broke", and a finished run competing for the same ink is
 * how a scan stops telling you anything (see the rule in overlays.css). So this is `categoryFor` minus
 * `done` — expressed by naming the two that DO earn ink, because the interesting question at every call
 * site is "is this urgent", and answering it by listing exclusions inverts on the next category added.
 *
 * The row accent reads this in production (via {@link attentionAccentFor}), so "which categories earn
 * ink" is decided in exactly one place. Three rollups read it too — the Project Rail row, the activity
 * group, and the fan-out group's "which lane needs you" — each of which used to spell the same rule as
 * `!category || category === 'done'`. Those three copies were the inversion this docstring warns about,
 * standing in the code: a fourth category would have begun counting as urgent at all three sites with
 * nothing going red. `rosterBadgeCount` also reads it, but that count feeds no collapsed roster badge —
 * no such badge is built, and nothing in production calls it (see its docstring). So do not read this
 * as "the badge and the ink are one number": today it is the ink and those three rollups.
 * The accent was a hand-written `needs-you || error` copy before this.
 *
 * 清单由 {@link ATTENTION_URGENCY} 派生，而不是自己写一份字面量。差别在加第四个 category 那天：一份
 * `['needs-you', 'error']` 的字面量对新成员**静默**——它默认不紧急，于是行不上墨、三处滚动归并把它
 * 当完成跳过、`rowAttentionLabel` 还会把它写成「in error」，一条都不红。`satisfies Record` 则逼着新
 * 成员的作者在下面那张表里做一次决定，少一个键就是 TS2741。这与 `categoryFor` 用穷举 switch 而不是
 * `default` 是同一条理由，只是那边守的是状态联合，这边守的是 category 联合。
 */
const ATTENTION_URGENCY = {
  'needs-you': true,
  error: true,
  // done 不吃墨、不进滚动归并：完成值一条通知，不值一个持续占着注意力的彩点（理由见上）。
  done: false
} satisfies Record<AttentionCategory, boolean>

export const URGENT_ATTENTION_CATEGORIES = Object.entries(ATTENTION_URGENCY)
  .filter(([, urgent]) => urgent)
  .map(([category]) => category) as readonly UrgentAttentionCategory[]

/** The categories that earn ink — the members of {@link ATTENTION_URGENCY} marked urgent. */
export type UrgentAttentionCategory = {
  [K in AttentionCategory]: (typeof ATTENTION_URGENCY)[K] extends true ? K : never
}[AttentionCategory]

/**
 * Whether this category is one a person should be interrupted for.
 *
 * A type guard, not a plain boolean, because every caller immediately uses the narrowed value — the
 * rollups rank it, the accent returns it. A boolean would send each of them back to a redundant null
 * check, which is exactly the hand-spelled exclusion this predicate exists to remove.
 */
export function isUrgentAttention(
  category: AttentionCategory | null
): category is UrgentAttentionCategory {
  return category !== null && ATTENTION_URGENCY[category]
}

/** The accent for one state: its urgent category, or null when it should carry none. */
export function attentionAccentFor(state: AgentDisplayState): AttentionCategory | null {
  const category = categoryFor(state)
  return isUrgentAttention(category) ? category : null
}

/**
 * The `status--<tier>` a single row's dot renders, or null for the neutral resting dot.
 *
 * ONE definition, because there were two and they had already gone wrong in the same way. The roster
 * row (`AgentRoster.tsx`) and the fan-out lane (`FanOutStrip.tsx`) each carried their own four lines,
 * both ending in `state === 'working' ? 'working' : null`. That final clause is the bug: it collapses
 * `running` — an Agent that is alive and between turns — into the same answer as "no state at all",
 * so the dot painted `--neutral-3`, the resting grey.
 *
 * That was visible, not theoretical. The status-bar counts and the project→Agent tree both bucket with
 * `sessionBoardColumn`, which counts `starting`/`running`/`working` as working. So the tree's heading
 * said "working agents" while rows inside it rendered idle grey dots. `chrome.css` has had
 * `.status--running` — green, and deliberately NOT pulsing — since the vocabulary was written; both
 * copies simply never emitted it.
 *
 * Why `running` is green-but-still rather than folded into `working`: the pulse means "a turn is in
 * flight right now". An Agent waiting for your next message is alive, not mid-turn, and pulsing it
 * would spend the one moving thing on screen on a row that needs nothing. `starting` stays null on
 * purpose too — it is transient, and flashing a tier for a few hundred milliseconds during launch is
 * noise, not information.
 *
 * 只收一个 state，不再并收一个 attention。两个调用点传的 attention 都恰好是 `categoryFor(state)`
 * （agent-roster.ts、fanout-group.ts 各一处），所以第二个入参不是第二个事实，只是同一个事实的另一条
 * 到达路径——而两条路径就是有一天答得不一样的前提。少了那个入参，「等你」和「在跑」也就不可能同时
 * 成立：一个状态只落一档，档位的优先级由这里的顺序一次定死。
 *
 * `exited` 与 `disconnected` 也各有一档，理由和 `running` 那次一模一样，只是慢了一轮才被看见。
 * 这个函数最初只把「在跑」那一侧补齐，终结与失联那一侧仍旧落到 null——于是同一个 Agent，Board 的卡
 * （board-run-card.ts）、标签页角标、切换器、Agents dock 都走 `status--<state>`：`exited` 是红的
 * （chrome.css 与 `error` 同组）、`disconnected` 是空心环；而名册行与 fan-out lane 画的是静止的中性灰。
 * 最要紧的是 `disconnected`：它在 `sessionBoardColumn` 里属于 **needs-you** 列，也就是说 Board 说
 * 「这条要你处理」，名册同一行却说「闲着」——正是本函数当初为 `running` 修掉的那个分岔，只不过发生
 * 在隔壁一列。`exited` 则可能带 `exitReason: 'crashed'`（client.ts 的退出分类），一个崩掉的 Agent 在
 * 扫一眼名册时读成 idle。
 *
 * `done` 仍然是 null，而且是**判断**不是疏漏：蓝色是「完成了」，它值一条通知但不值一个持续占着注意力
 * 的彩点——这与 {@link attentionAccentFor} 里「done 不吃墨」同一条理由，也与 ATTENTION_SORT_RANK 让
 * done 与 idle 同档一致。`starting` 同样刻意留空（瞬态，见上）。所以这个函数的 null 有两种成员：
 * 「没有状态」和「有状态但刻意不画」，后者只有 done 与 starting 两个，各自都在上面写明了理由。
 *
 * 返回值就是**状态名本身**，因为 CSS 的类名就是按状态命名的（`.status--<state>`，chrome.css 的
 * 状态词汇表一节）。所以 `blocked` 得到 `.status--blocked` 而不是被折进 `waiting`：样式表给这两个
 * 类完全相同的琥珀色与 `?` 角标，画面一模一样，但判定层不必替样式表做一次多余的归并。
 * needs-you 那一档经 {@link isNeedsYouState} 取得，而不是在这里把状态名再抄一遍——抄一遍今天正确，
 * 只在联合新增成员那天出错，而那天没人会看这个文件（attention-vocabulary.test.ts 守这条）。
 *
 * 穷举 switch、无 default，和 `categoryFor` / `attentionSortClass` / `sessionBoardColumn` / `statusLabel`
 * 同一个形状。这一段此前是一条 if 链、以 `return null` 收尾，于是这一族里**只剩它**对第十个状态静默：
 * 四个兄弟一起报 TS2366 的那一刻，它安静地把新状态判成中性灰。严重度本来就不高（作者被兄弟们逼进
 * 同一个文件，多半顺手就看见了），但代价是零——`state === null` 先收窄掉空值，`isNeedsYouState` 再
 * 收窄掉 needs-you 两支，残差恰好是剩下七支，少列一支就是「缺少结尾 return」。
 */
export function statusDotTier(
  state: AgentDisplayState | null
): NeedsYouState | 'working' | 'running' | 'error' | 'exited' | 'disconnected' | null {
  if (state === null) return null
  if (isNeedsYouState(state)) return state
  switch (state) {
    case 'error':
    case 'working':
    case 'running':
    case 'exited':
    case 'disconnected':
      return state
    // done 与 starting 刻意不画，各自的理由见上：前者是「完成了」不值一个常驻彩点，后者是瞬态。
    case 'done':
    case 'starting':
      return null
  }
}

/**
 * 「这个状态在活动菜单里画哪个字形」——{@link statusDotTier} 的字形投影，不是第二份状态判定。
 *
 * 项目 hover 菜单此前就地手抄了一份 `state === 'working' ? 'working' : state === 'running' ?
 * 'running' : 'neutral'`：对 working / running 两支答对，其余七支全塌成中性灰。它与 `statusDotTier`
 * 回答的是同一个问题（这个状态长什么样），于是 working-count-convergence 的两条结构断言同时指着它。
 *
 * 收成投影而不是扩成七档：那一行旁边的 `data-attention` 已经承载注意力档，字形只需要区分「在产出」
 * 「活着但没产出」「其余」三种——这与收敛前的视觉**逐档相同**，变的只是判据从两处变一处。真要给
 * error / exited / needs-you 各自的字形，是一个设计决定，那时只改这一个函数，不必回到组件里再抄一遍。
 */
export function activityGlyphFor(state: AgentDisplayState | null): 'working' | 'running' | 'neutral' {
  const tier = statusDotTier(state)
  if (tier === 'working') return 'working'
  if (tier === 'running') return 'running'
  return 'neutral'
}

/**
 * The one ORDERING the attention surfaces sort by, most urgent first.
 *
 * The roster and the quick switcher both rank rows, and both must agree about who sorts above whom.
 * They were two hand-written tables before this, and they had already drifted: the roster sorted a
 * finished Agent strictly above an idle one while the switcher tied them. This is the single decision
 * they now share, so that divergence cannot come back (guarded in attention-ordering.test.ts).
 *
 * It is keyed on a coarse sort CLASS rather than on AgentDisplayState on purpose. "Does this state need
 * a person" is decided once, in {@link isNeedsYouState} (see attention-vocabulary.ts), and each surface
 * routes through that table and arrives here already classified — so this file never re-spells the
 * needs-you states, and the ranking stays a separate, single concern from the needs-you predicate.
 *
 * `done` and `idle` share a rank deliberately. A finished-but-unlooked-at Agent is NOT more urgent than
 * an idle one until there is an unread/seen axis to say it has not yet been looked at — and there is
 * none. #199 is that axis (a separate feature, deliberately not built here); #246 records that ranking
 * `done` above idle is contrary to every reference product while no such axis exists. So this tie is a
 * compromise pending #199, not a settled claim that completion outranks idleness.
 */
export type AttentionSortClass = AttentionCategory | 'working' | 'idle'

const ATTENTION_SORT_RANK: Record<AttentionSortClass, number> = {
  'needs-you': 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 3
}

/**
 * 每个排序类的名字，取自排序表本身。
 *
 * 导出它是因为这些名字已经被手抄了第五份：结构守卫（attention-ordering.test.ts）要认出「谁又自己
 * 写了一份序表」，就得知道这些名字，而它此前手抄了一行字面量。
 *
 * 手抄那份与表分岔时，最坏的后果不是漏判某个副本，而是守卫**掉头指向错误的结论**：新类进了表、
 * 没进清单，表就不再满足「所有键都是排序类」，于是连 SSOT 自己都不被认成序表——扫描报的是
 * 「共享的表整个不见了」，而表就在那儿一行没动。一个如实的守卫不该在被正确扩充时说出假话。
 *
 * `Record<AttentionSortClass, number>` 的键让 tsc 挡住漏项：加了联合成员却不填表就是编译错，
 * 所以这份清单不可能比联合少。运行期只用于成员判定（`includes`），与顺序无关。
 */
export const ATTENTION_SORT_CLASSES = Object.keys(
  ATTENTION_SORT_RANK
) as readonly AttentionSortClass[]

export function attentionSortRank(sortClass: AttentionSortClass): number {
  return ATTENTION_SORT_RANK[sortClass]
}

/**
 * 一个状态属于哪个排序类——排序的**上半段**，与 `attentionSortRank` 的下半段合起来才是完整判定。
 *
 * 为什么必须只有一份：这里问的是「这个状态有多急」，而排名表回答「这个急迫档排第几」。后者一直是
 * SSOT（`ATTENTION_SORT_RANK`，由 attention-ordering.test.ts 守着），前者此前在三个地方各写一份，
 * 其中两份是有损的三元式 `state === 'working' ? 'working' : 'idle'`。今天九个状态下三份答案一致，
 * 所以任何行为断言都是绿的——**分歧要等到加第十个状态那天才发生**，而那正是没人会回头检查这里的时刻。
 *
 * 穷举而不是 `default`，是为了让那一天**响亮**：`isNeedsYouState` 的类型谓词先收窄掉 needs-you 两支，
 * `error` / `working` / `done` 三个 case 各收窄一支，残差恰好是 `starting / running / disconnected /
 * exited` 四支。少列一支，返回类型就含 `undefined`，TS2366「缺少结尾 return」当场编译不过——新状态的
 * 作者被迫在这里做一次决定，而不是默默拿到 idle。有损三元式给的是相反的待遇：它永远编译得过。
 *
 * 本函数从 quick-switch.ts 的 `attentionRank` 提上来，行为逐一等价（`done` 仍单独成类，它与 idle 只是
 * **目前**在排名表里同级，pending #199 的未读/已读轴）。这是本仓第三次遇到同一个形状：dc77127c 修掉了
 * 状态点那份，quick-switch 修掉了排序那份，剩下的两份在这里收口。
 */
export function attentionSortClass(state: AgentDisplayState | null): AttentionSortClass {
  if (state === null) return 'idle'
  if (isNeedsYouState(state)) return 'needs-you'
  switch (state) {
    case 'error':
      return 'error'
    case 'working':
      return 'working'
    case 'done':
      return 'done'
    case 'starting':
    case 'running':
    case 'disconnected':
    case 'exited':
      return 'idle'
  }
}

/**
 * Fold a batch of Sessions against the previously known states, returning every event worth raising.
 *
 * Callers own the previous-state map because they own the lifetime of the projection; keeping it out
 * of here is what lets this stay pure and lets the same decision serve a notification, a row rollup,
 * and the roster without three copies of the bookkeeping.
 */
export function attentionEvents(input: {
  sessions: readonly SessionSnapshot[]
  previousStates: ReadonlyMap<string, AgentDisplayState>
  // Answers "can the user see this Session right now" per Session id.
  visibilityFor: (sessionId: string) => AttentionVisibility
}): AttentionEvent[] {
  const events: AttentionEvent[] = []
  for (const session of input.sessions) {
    if (session.kind !== 'agent') continue
    const event = attentionEventFor({
      session,
      previousState: input.previousStates.get(session.id) ?? null,
      visibility: input.visibilityFor(session.id)
    })
    if (event) events.push(event)
  }
  return events
}

/**
 * The next previous-state map, given the Sessions just projected.
 *
 * Sessions that disappeared are dropped rather than remembered: if one comes back it is a first
 * sight again, which correctly stays quiet instead of firing for a transition nobody witnessed.
 */
export function nextAttentionStates(
  sessions: readonly SessionSnapshot[]
): Map<string, AgentDisplayState> {
  const states = new Map<string, AgentDisplayState>()
  for (const session of sessions) {
    if (session.kind !== 'agent') continue
    states.set(session.id, session.status.state)
  }
  return states
}
