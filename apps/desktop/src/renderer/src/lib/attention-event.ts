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

// `done` is the only state that means the Agent finished its turn. `exited` is the process leaving,
// which is a lifecycle fact rather than a result, and it already shows up in the tab and Board.
function isFinished(state: AgentDisplayState): boolean {
  return state === 'done'
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
 */
export function categoryFor(state: AgentDisplayState): AttentionCategory | null {
  if (isNeedsYouState(state)) return 'needs-you'
  if (isFinished(state)) return 'done'
  if (state === 'error') return 'error'
  return null
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
 * ink" is decided in exactly one place. `rosterBadgeCount` also reads it, but that count feeds no
 * collapsed roster badge — no such badge is built, and nothing in production calls it (see its
 * docstring). So do not read this as "the badge and the ink are one number": today it is only the ink.
 * The accent was a hand-written `needs-you || error` copy before this.
 */
export const URGENT_ATTENTION_CATEGORIES = ['needs-you', 'error'] as const

export function isUrgentAttention(category: AttentionCategory | null): boolean {
  return category !== null && (URGENT_ATTENTION_CATEGORIES as readonly string[]).includes(category)
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
 */
export function statusDotTier(
  state: AgentDisplayState | null
): NeedsYouState | 'working' | 'running' | 'error' | 'exited' | 'disconnected' | null {
  if (state === null) return null
  if (isNeedsYouState(state)) return state
  if (state === 'error') return state
  if (state === 'working' || state === 'running') return state
  if (state === 'exited' || state === 'disconnected') return state
  return null
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
