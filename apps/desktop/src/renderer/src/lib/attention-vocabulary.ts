import type { AgentDisplayState } from '@agentmux/core'

/**
 * 「需要人介入」的那些状态，作为一个**类型**。
 *
 * 它是这个概念的 SSOT：`'waiting' | 'blocked'` 只在这里写一次，下面的判定表由它派生，
 * {@link isNeedsYouState} 也据它收窄。把它做成类型（而不是只做成 Record 的一批 `true`）是 site 2 的
 * 承重件——`quick-switch.ts` 被 attention-vocabulary.test.ts 的 layer 4 禁止在代码里出现 `'waiting'` /
 * `'blocked'` 字面量，所以它没法自己写一个含这两支的穷举 switch；只有让 `isNeedsYouState` 收窄成
 * `state is NeedsYouState`，排序函数在守卫之后拿到的残差类型里才不再有这两支，剩下的状态才能被一个
 * 无 default 的 switch 逼成穷举。换句话说：这个类型存在，是为了让**别处**的穷举成为可能，而不是为了
 * 在本文件里再判一次。
 */
export type NeedsYouState = 'waiting' | 'blocked'

/**
 * Which Agent states mean "a person needs to do something".
 *
 * This is the one definition. Five surfaces asked the question before this file existed — the
 * notification decision, the window rollup, the roster ranking, the quick switcher's ordering, and the
 * quick switcher's row colour — and each spelled the answer out itself as `state === 'waiting' ||
 * state === 'blocked'`. Two of them carried a comment promising they were "kept identical to" another
 * one, which is exactly the shape that drifts: a promise in prose that nothing checks.
 *
 * 两层保护，都在类型层，缺一不可：
 *
 *   1. **表覆盖整个联合**：键类型是 `{ [K in AgentDisplayState]: … }`，少一个成员就编译不过。给 Core 的
 *      {@link AgentDisplayState} 加一个状态却不在这里给它一个裁决，desktop 构建在**这里**、一次、指着
 *      新名字失败——而不是在五个调用点静默落到 `false`、把新状态一起从每个关注度界面里丢掉。
 *   2. **裁决派生自 {@link NeedsYouState}**：每个值的类型是 `K extends NeedsYouState ? true : false`，
 *      所以表里的 `true`/`false` 不是随手写的、可以和类型漂开的两份真相——把 `waiting` 改成 `false`
 *      直接编译不过（实测 TS2322）。表本身仍是 SSOT 的**运行期投影**：`isNeedsYouState` 读它，
 *      `AGENT_DISPLAY_STATES` 也从它取键，所以它必须作为一个裸对象字面量存在（needs-you-predicate-
 *      scope.test.ts 直接按 `TrueKeyword` 初始值读它的 true 项，套一层 `as const` / `satisfies` 会让
 *      那个读取失效）。
 *
 * The verdicts, and why:
 *
 *   - `waiting` / `blocked` — the Agent has surfaced a request, or cannot proceed. Nothing moves until
 *     a person acts. This is the whole class.
 *   - `starting` / `running` / `working` — it is doing the work. Interrupting is the opposite of help.
 *   - `done` / `exited` — finished, and finishing is its own category (see `categoryFor`): worth a
 *     notification, not worth the amber "you are the blocker" treatment.
 *   - `error` — also its own category, and deliberately NOT this one. Amber says "you are being waited
 *     on"; red says "this broke". Folding them loses the difference at a glance, which is the one
 *     thing a colour is for.
 *   - `disconnected` — a dropped link is not a request. It has its own neutral treatment precisely so
 *     amber can mean needs-you and nothing else.
 */
const NEEDS_YOU_BY_STATE: { [K in AgentDisplayState]: K extends NeedsYouState ? true : false } = {
  starting: false,
  running: false,
  disconnected: false,
  working: false,
  waiting: true,
  blocked: true,
  done: false,
  exited: false,
  error: false
}

/**
 * Does this state mean an Agent needs a person?
 *
 * Every attention surface routes through here. A surface that wants a coarser bucket — the Board's
 * four kanban columns, say — is answering a different question and must not be built by widening this
 * one; see `sessionBoardColumn`, which is deliberately its own mapping.
 *
 * 返回类型是**类型谓词** `state is NeedsYouState` 而非 `boolean`：调用点用它作 `Array.filter` 或早退
 * 守卫时，通过之后 `state` 的类型里就少了 needs-you 那几支。这不是为了在本文件里做什么，是给
 * `quick-switch.ts` 的穷举 switch 让路——见 {@link NeedsYouState} 的注释。运行期行为与原来完全一致
 * （读表、返回布尔），谓词只是把「这个布尔意味着哪个更窄的类型」也告诉编译器。
 */
export function isNeedsYouState(state: AgentDisplayState): state is NeedsYouState {
  return NEEDS_YOU_BY_STATE[state]
}

/**
 * Every Agent display state, as values.
 *
 * Derived from the verdict table rather than written out a second time, so the list and the verdicts
 * cannot disagree about which states exist. Tests use it to drive a case per state without hand-copying
 * nine names — a hand-copied list is how a new state ends up untested at exactly the moment it is new.
 *
 * Order is the union's declaration order, which is roughly lifecycle order. Nothing should depend on
 * it; sort if the order matters to you.
 */
export const AGENT_DISPLAY_STATES = Object.keys(NEEDS_YOU_BY_STATE) as readonly AgentDisplayState[]
