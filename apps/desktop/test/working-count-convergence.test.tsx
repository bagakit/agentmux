import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// 「窗口里每个『有几个 Agent 在干活』的计数都用同一个判据」的回归守护。
//
// 由来（task #582，用户在真实桌面上实测）：同一个窗口、同一批 Agent，四处报出两组数——
//   Scratch 侧栏「3 Agents are running」、Board 的 WORKING 列 3、Provider 汇总
//   「Claude 2 + Codex 1 + Grok 1 = 4 active」，而底部状态栏「0 working」。
//
// 根因不是数错，是**两个判据**：状态栏那一列曾写 `session.status.state === 'working'`，另外三处走
// `sessionBoardColumn(session) === 'working'`（working 列含 `starting`/`running`/`working`）。
// 差额全是 `running`。
//
// 为什么这个分岔必然显形、而不是理论上的：`running` 不是边角状态而是**主稳态**。它的唯一来源是
// `agentDisplayState`（core/agent-status-freshness.ts:81）的 `unknown → 'running'`，而那个函数
// 自己的注释（:76-79）列出三条到达它的路：hook-normalizer（Provider 的 rules 认不出事件）、
// session-state 的 agent-status 分支（含 ACP）、以及 15 分钟静默衰减
// （`DECAYED_SEMANTIC_STATE` 就是 `unknown`，:57）。所以严格判据的稳定结论就是"一个都没在跑"，
// 恰好是用户看到的 0。
//
// 本段此前写的是「`api.ts` 在启动与 attach 时就写它」并点名一个不存在的 `decayedDisplayState`。
// 两处都错：那七个行号指的是 `processState`（`AgentMuxRunState`，与 `status.state` 是**不同的字段**），
// 而 `api.ts` 是 browser preview 的 mock，根本不是生产的状态写入路径。留这段是因为
// 「理由指错了地方」比「没有理由」更贵——它读起来像已经查证过。
//
// #419 修过这一族，但只收敛了 Provider 那一半（6a021dc「活跃的定义只有一处」），并在
// agent-attention.ts 留下一段注释把剩下的分岔声明成「两套刻意不同的口径」。**那句话是错的**，而且它
// 上面三行刚好描述了自己脚下的缺陷。刻意的差异是「关注度（谁在等我）vs 活动（谁在干活）」这条线，
// 不是同一条线上的两种算法。一条读起来像已决之事的注释会让下一个人不回头看表，所以那句话已被换掉。
//
// 判据分三层，各自能独立红：
//   1. 渲染层：按用户真正**看到的文本**判，不是按投影的返回值。投影返回 3 不等于状态栏画出 3。
//   2. 跨投影一致性：四个消费者对同一批 Session 必须给出同一个数。
//   3. 结构层：计数投影的代码里不得自己判一次「在跑吗」。行为层只能证明"今天这几处一致"，证不了
//      "明天没人再抄一份"——新抄的那份对今天的 fixture 可能恰好也对（#535 的教训：等价性抓不到
//      新手抄的一份）。
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  // 状态栏挂着资源面板，资源面板在 import 阶段就要判断跑在哪个宿主里。不先立这个全局，
  // 一条断言都跑不到。
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { AgentDisplayState } from '@agentmux/core'
import {
  summarizeAgentAttention,
  summarizeProviderActivity
} from '../src/renderer/src/lib/agent-attention.js'
import { sessionBoardColumn, workingAgentCount } from '../src/renderer/src/lib/project-board.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    selectSession: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))

import { AgentStatusBar } from '../src/renderer/src/components/AgentStatusBar.js'

/**
 * 全部九个显示态，硬写一份。
 *
 * 刻意不从被测的投影派生：期望值若由被测对象算出，就会跟着变异一起漂而恒真
 * （memory: expected-value-must-not-derive-from-mutation-target）。自检 1 再把这份手抄与运行期
 * 真相对上，所以漂移会红在那里，而不是让下面每条断言在一个错的参照上比对。
 *
 * 外部锚点是 `AgentDisplayState` 这个 union 本身（core/src/types.ts），由自检 1 逐成员比对。
 * 刻意不改成 import `attention-vocabulary.ts` 的 `AGENT_DISPLAY_STATES`（它**存在**，
 * 由 `Object.keys(NEEDS_YOU_BY_STATE)` 派生，`attention-vocabulary.test.ts` 已把它与 core union
 * 对齐）：那是**同一层**（renderer lib）里的另一份派生，本文件要的是**跨包**的外部锚点，而 union
 * 是编译期的，取它只能靠 parse 类型别名，见 `displayStateUnionMembers`。
 */
const ALL_DISPLAY_STATES: readonly AgentDisplayState[] = [
  'starting', 'running', 'working', 'waiting', 'blocked', 'disconnected', 'done', 'exited', 'error'
]

/** Board 的 working 列收着哪几个态。同样硬写，理由同上。 */
const STATES_THAT_MEAN_WORKING: readonly AgentDisplayState[] = ['starting', 'running', 'working']

/**
 * 一个 agent Session。形状照 `agent-status-bar.test.tsx` 那份——状态栏挂着 roster，roster 会算
 * usage（`agentUsageDisplay` 读 `capabilities`），少了那一层整棵渲染会抛 TypeError 而不是给出判定。
 */
function agentSession(
  id: string,
  state: AgentDisplayState,
  providerId = 'claude',
  workspacePath = '/repo'
): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId,
    executorId: providerId,
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'respond',
      providerResume: true,
      replyCorrelation: 'native-turn-id'
    },
    hostId: 'local',
    workspacePath,
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as SessionSnapshot
}

/**
 * 状态栏那一段渲染出的可见文本，形如 `3 working`。判的是用户读到的东西。
 *
 * 取法：那一段用 `data-attention="working"` 标出自己，段内先画一枚 aria-hidden 的状态点，随后是
 * 计数与标签两个 span。所以从标记处往后取**第一对** count/label 就是这一段自己的。
 * 刻意不用"取到下一个 `data-attention` 之间再剥标签"的写法：段尾的 `</span>` 落在下一段开头之前，
 * 剥完会留下一个游离的 `>`（这正是本函数第一版的缺陷，被自检 2 抓住）。
 */
function renderedWorkingText(sessions: readonly SessionSnapshot[]): string | null {
  fixture.state.sessions = [...sessions]
  const markup = renderToStaticMarkup(createElement(AgentStatusBar) as ReactElement)
  const marker = markup.indexOf('data-attention="working"')
  if (marker < 0) return null
  const pair =
    /agent-status-bar__count">([^<]*)<\/span><span class="agent-status-bar__label">([^<]*)<\/span>/
      .exec(markup.slice(marker))
  if (!pair) return null
  return `${pair[1]} ${pair[2]}`
}

describe('窗口里每个「有几个在干活」的计数都用同一个判据', () => {
  it('自检 1：本文件硬写的两张状态表与运行期真相一致（否则下面全部退化成对空集恒真）', () => {
    for (const state of ALL_DISPLAY_STATES) {
      expect(
        sessionBoardColumn(agentSession('probe', state)),
        `sessionBoardColumn 对 ${state} 没有归类——本文件的状态表与真相漂了`
      ).toBeTruthy()
    }
    // 反向：working 列恰好是硬写的那三个，不多不少。
    expect(
      ALL_DISPLAY_STATES.filter((state) => sessionBoardColumn(agentSession('p', state)) === 'working'),
      'Board 的 working 列成员变了——先确认这是刻意的产品变化，再改本文件的常量'
    ).toEqual([...STATES_THAT_MEAN_WORKING])
    expect(ALL_DISPLAY_STATES.length, '九个显示态少了').toBe(9)
    // 外部锚点：那九个就是 core 的 union 的**全部**成员，不多不少。上面两条只问"这九个都归了类"
    // ——core 加第十个态时它们只是少跑一圈，静默通过。裸字面量 9 同理：它由本文件自己的数组算出，
    // 是同一份手抄的自证。比对不看顺序：union 的书写顺序不是产品事实。
    expect(
      [...ALL_DISPLAY_STATES].sort(),
      'core 的 AgentDisplayState 变了——先确认新态该归哪一列，再改本文件的常量'
    ).toEqual(displayStateUnionMembers().sort())
  })

  it('自检 2：渲染真的取到了那一段文本（否则下面读到 null，断言在读不到的东西上比对）', () => {
    // 段落选择器若失配（类名/属性改名），`renderedWorkingText` 恒返回 null；那时"画出的数不对"
    // 与"没画"不可区分。这条把"读得到"本身做成断言。
    expect(renderedWorkingText([agentSession('only', 'working')])).toMatch(/^\d+ working$/)
  })

  it('状态栏画出的数字对每个显示态都等于 Board 的判定（渲染层，逐态）', () => {
    // 这是 #582 的直接位点，也是唯一按"用户看到什么"判的一层。
    // 严格判据（`state === 'working'`）在这里对 starting 与 running 各红一次。
    for (const state of ALL_DISPLAY_STATES) {
      const expected = STATES_THAT_MEAN_WORKING.includes(state) ? 1 : 0
      expect(
        renderedWorkingText([agentSession('only', state)]),
        `状态栏对 ${state} 画出的不是 ${expected} working——它与 Board 判得不一样`
      ).toBe(`${expected} working`)
    }
  })

  it('状态栏画出的数字在混合状态下也等于 Board 的判定（渲染层，混合）', () => {
    // 逐态那条每次只喂一个 Session，读到的恒是 0 或 1；一个把计数写成"有没有"的实现（`? 1 : 0`）
    // 能全过。这条喂三个在跑 + 两个不在跑，只有真的在计数才是 3。
    const sessions = [
      agentSession('s1', 'starting'),
      agentSession('s2', 'running'),
      agentSession('s3', 'working'),
      agentSession('s4', 'waiting'),
      agentSession('s5', 'done')
    ]
    expect(renderedWorkingText(sessions)).toBe('3 working')
  })

  it('四个消费者对同一批 Session 报出同一个数（跨投影一致性）', () => {
    // 用户实测的那一组：3 个在跑（含 running 与 starting）、1 个等你、1 个完成。
    // 缺陷形态下 rollup=1（只有真 working 那个）而另外三处=3。
    const sessions = [
      agentSession('a', 'running'),
      agentSession('b', 'working'),
      agentSession('c', 'starting'),
      agentSession('d', 'waiting'),
      agentSession('e', 'done')
    ]
    const boardCount = workingAgentCount(sessions)
    const rollupCount = summarizeAgentAttention(sessions).working
    const providerActive = summarizeProviderActivity(sessions)
      .reduce((sum, entry) => sum + entry.active, 0)
    const renderedCount = Number(/^(\d+)/.exec(renderedWorkingText(sessions) ?? '')?.[1])

    expect(boardCount, '基线：Board 的 workingAgentCount').toBe(3)
    expect(rollupCount, '整窗 rollup 与 Board 不一致——这正是 #582').toBe(boardCount)
    expect(providerActive, 'Provider 汇总与 Board 不一致').toBe(boardCount)
    expect(renderedCount, '画出来的数与 Board 不一致').toBe(boardCount)
  })

  it('跨 Provider 分组不改变总数（Provider 汇总是同一个数的分组，不是第二个数）', () => {
    // 用户看到的 "Claude 2 active、Codex 1 active、Grok 1 active" 加起来是 4；
    // 那 4 必须等于整窗那一个数，否则两处仍在各自判。
    const sessions = [
      agentSession('c1', 'running', 'claude'),
      agentSession('c2', 'working', 'claude'),
      agentSession('x1', 'starting', 'codex'),
      agentSession('g1', 'running', 'grok'),
      agentSession('g2', 'blocked', 'grok')
    ]
    const providerActive = summarizeProviderActivity(sessions)
      .reduce((sum, entry) => sum + entry.active, 0)
    expect(providerActive).toBe(4)
    expect(summarizeAgentAttention(sessions).working).toBe(providerActive)
    expect(workingAgentCount(sessions)).toBe(providerActive)
  })

  it('「谁在等我」仍是另一套口径——收敛 working 不许把 needs-you 一起折进去', () => {
    // 上面几条都在推"同一个问题共用一个判据"。反向的界必须同时钉住，否则一次过度收敛
    // （把 needsYou 也换成 board 列）会让 waiting/blocked 变成 0 而全部绿。
    const sessions = [
      agentSession('w', 'waiting'),
      agentSession('b', 'blocked'),
      agentSession('r', 'running'),
      agentSession('e', 'error')
    ]
    const rollup = summarizeAgentAttention(sessions)
    expect(rollup.needsYou, 'waiting + blocked 才是 needs-you').toBe(2)
    expect(rollup.error, 'error 自成一类，不进 needs-you 也不进 working').toBe(1)
    expect(rollup.working, 'running 在跑；error/waiting/blocked 都不在跑').toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 结构层：不许再抄一份「在跑吗」的判据。
//
// 上面的行为断言只能证明"今天这几处一致"，证不了"明天没人写第五个消费者自己判一次"。
//
// 这一层刻意**不是**「禁止形状不在场」那种门——那种门既漏又误伤（memory:
// forbidden-shape-guard-misfires）。实测就误伤了一处：`composer-submit-mode.ts` 用
// `state === 'working'` 决定主按钮是 Stop 还是 Send，而那是**另一个问题**——一个 idle-`running`
// 的 Agent 没有在途回合可以打断，它的主按钮就该是 Send（那个文件自己的注释写明了这一点）。
// 把它算成违规、或者为了让门变绿而悄悄收窄判据，都是拿判据迁就实现。
//
// 所以判据是**钉住已知集合**：全仓每一处「拿 `.state` 与 `'working'` 比」的位置都列在下面，各自带
// 一句为什么它不是计数。新增一处就红——它要么该改成调 `sessionBoardColumn`，要么该在这里说清自己
// 回答的是哪个不同的问题。这条门抓的是**增长**，不是"字符串在场"。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(here, '..', 'src', 'renderer', 'src')
const boardPath = join(rendererRoot, 'lib', 'project-board.ts')
const attentionPath = join(rendererRoot, 'lib', 'agent-attention.ts')
const coreTypesPath = join(here, '..', '..', '..', 'packages', 'core', 'src', 'types.ts')

/**
 * `AgentDisplayState` 这个 union 的成员，从 core 的源码里读出来。
 *
 * 为什么要 parse 而不是 import：union 是编译期的，想让本文件手抄的九个态有一个**跨包**的锚点，
 * 只能取 core 那个类型别名本身。renderer 侧确实有一个运行期数组
 * （`attention-vocabulary.ts` 的 `AGENT_DISPLAY_STATES`，由 `NEEDS_YOU_BY_STATE` 的键派生），
 * 但它与本文件同层，且它自己也要靠 `attention-vocabulary.test.ts` 去与这同一个 core union 对齐——
 * 拿它当锚点等于把两份派生互相担保，core 加第十个态时两边可以一起沉默。
 *
 * 这条锚点回答的问题与自检 1 前半段不同：前半段问「这九个态 `sessionBoardColumn` 都归了类吗」，
 * 那是**投影侧**的完整性；这里问「这九个就是全部吗」，是**类型侧**的完整性。少了后者，core 加第十个
 * 态时上面每条逐态循环都只是少跑一圈——静默，而不是红。
 */
function displayStateUnionMembers(): string[] {
  const source = ts.createSourceFile(
    coreTypesPath,
    readFileSync(coreTypesPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let members: string[] | null = null
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'AgentDisplayState') return
    if (!ts.isUnionTypeNode(node.type)) return
    members = node.type.types.flatMap((member) =>
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : []
    )
  })
  // 拿不到就抛，不返回空数组。不是因为"空集相等会恒真"——比对的左边是本文件手抄的九个字面量，
  // 右边空集时那条断言照旧红。抛的价值是**把红的原因说对**：锚点断了（类型别名改名、搬走、不再是
  // 字面量 union）与"core 真的改了成员"是两件事，前者若沉默地退化成空集，读到的会是那条断言的
  // "core 的 AgentDisplayState 变了"，于是有人去改本文件的常量迁就一个已经不存在的参照。
  if (!members) throw new Error(`${coreTypesPath} 里找不到 AgentDisplayState 的字面量 union——锚点断了`)
  return members
}

/**
 * HEAD 上每一处「`.state` 与 `'working'` 直接相比」的位置，以及它为什么不是「有几个在干活」。
 *
 * 键是相对 renderer 根的 `路径:行`。行号会随编辑漂，所以断言只比**路径集合**，不比行号——
 * 行号写在这里是给读的人定位用的。
 */
const NON_COUNT_STATE_COMPARISONS: Readonly<Record<string, string>> = {
  // 主按钮是 Stop 还是 Send。idle-running 的 Agent 没有在途回合可打断，故此处严格判 working 是对的。
  '/lib/composer-submit-mode.ts':
    '决定 Stop/Send，问的是"有在途回合吗"而不是"在 working 列吗"',
  // 单行/单 lane 的状态点，不是计数——问的是「这一行画哪一档」。曾是 `/components/AgentRoster.tsx`
  // 与 `/components/FanOutStrip.tsx` 两条，各自手写四行判定；#572 记的那个分岔就出在这里，而且
  // **是真的画错了**：两份都以 `state === 'working' ? 'working' : null` 收尾，于是 running 与「没有
  // 状态」同答案，点画成静止的中性灰，而计数树的标题按 sessionBoardColumn 把它算作 working。
  // 现已合并成 `attention-event.ts` 的 statusDotTier 一处，running 走它自己那一档（.status--running
  // 在 chrome.css 里一直就有：绿、不脉冲）。两个组件的条目因此删掉——它们不再自己判。
  '/lib/attention-event.ts':
    '两处，都问"这一个状态归哪一档"而不是"有几个在干活"。(1) statusDotTier：这一行的点画哪一档，'
    + 'working 与 running 各一档，因为脉冲的含义是"此刻有 turn 在途"，而 running 是活着但不在途中。'
    + '(2) attentionSortClass：这一个状态排哪个序类，穷举 switch，喂给 attentionSortRank',
  // 下面两条是把检测器从「`x.state` 比 working」放宽到「也认裸名 `state`」之后**当场浮出来**的——
  // 它们一直就在生产代码里，只是先把状态存进了一个叫 state 的局部变量/形参，于是整张表对它们失明。
  // 记在这里而不是回退检测器：两处都不是计数，各自回答别的问题，但「这一处到底问什么」必须写下来，
  // 否则下一个人看到它们仍会以为这里没人判过 working。
  '/components/AgentStatusBar.tsx':
    'StatusCount 的图标三元：问"这一档配哪个图标"。数字由 rollup 算好后传进来，这里不参与计数',
  '/lib/resource-usage-panel.ts':
    '资源面板每行的尾巴："在干活"就不显示闲置时长，否则显示闲了多久。问的是"这一行要不要报 idle"'
  // `/lib/agent-roster.ts` 与 `/lib/activity-groups.ts` 曾各占一条，理由都写着「单 Session 排序类，
  // 喂给 attentionSortRank」。两处写的都是有损的 `state === 'working' ? 'working' : 'idle'`——对今天
  // 九个状态答案正确，但第十个状态会**静默**落进 idle，而同一个判定在 quick-switch.ts 是穷举 switch，
  // 加状态时那里编译不过、这两处照样过。判定已提成 attention-event.ts 的 `attentionSortClass`（穷举、
  // 无 default），三处一起委派给它，所以这两条从表里删掉——它们不再自己判。
  //
  // `/components/ProjectActivity.tsx` 曾在这里，理由是「单行标签 active now vs idle 时长」。那一处
  // 已搬进 `/lib/project-activity-row.ts`，并且搬的时候改成了 `sessionBoardColumn(...) === 'working'`
  // ——即不再自己拿 state 比字面量，而是委派给唯一裁决点。所以它从这张表里删掉：留着就成了一条
  // 守着空地的豁免。它在 WORKING_LITERAL_SITES 里仍有一条（switch 的 case），那是另一个问题。
  //
  // `/lib/fanout-group.ts` 曾在这里，理由写的是「作用域是那一组而非整窗」。那不是理由：作用域只
  // 影响分母，不改变"谁算在干活"这个判据。它的 `groupProgress().working` 已改成走
  // `sessionBoardColumn`，所以从这张表里删掉——下面 `gone` 那条断言会盯着这件事。
}

function tsFilesUnder(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root, { recursive: true }) as string[]
  } catch {
    return []
  }
  return entries
    .filter((rel) => rel.endsWith('.ts') || rel.endsWith('.tsx'))
    .map((rel) => join(root, rel))
}

/**
 * 一个文件里所有「把某个 `.state` 成员表达式与字符串 `'working'` 相比」的位置。
 *
 * 判的是**取值位**而不是文本：`state === 'working'` 与 `'working' === state`（Yoda）两种拼法都要
 * 认出来，否则换个写法就绕过。同时只认与 `.state` 的比较——局部变量 `column === 'working'` 是在读
 * `sessionBoardColumn` 的返回值，那是**正确**用法，不能误伤。
 */
function stateEqualsWorkingSites(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = []
  // 三种拼法都算「拿 state 比 working」：`x.state`、`x['state']`，以及一个就叫 `state` 的裸名字。
  // 第三种是后补的，补的时候它已经在生产代码里了（statusDotTier 的形参）——而在补之前，
  // `const state = row.state` 再比一次，整个检测器对它**完全失明**：只要先把它存进一个局部变量，
  // 这张表守着的每一条旁路都重新打开。名字定得死（必须叫 `state`）是刻意的：这不是类型推断，
  // 是拼法判据，放宽到「任意标识符」会把 `column === 'working'` 之类真正该在别处判的东西卷进来。
  const readsState = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === 'state') ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'state') ||
    (ts.isIdentifier(node) && node.text === 'state')
  const isWorkingLiteral = (node: ts.Expression): boolean =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'working'

  const walk = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind
      const isComparison =
        kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        kind === ts.SyntaxKind.EqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsToken
      if (
        isComparison &&
        ((readsState(node.left) && isWorkingLiteral(node.right)) ||
          (readsState(node.right) && isWorkingLiteral(node.left)))
      ) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
      }
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return lines
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/**
 * 一个文件里所有「拿 `sessionBoardColumn(...)` 的返回值与 `'working'` 相比」的位置——正向判据。
 *
 * 上面两个检测器都是"不许出现"，只能证明**没有**第二份判据；它们证不出**有**那一次委派。
 * 这个负责后者，而且返回行号（不是布尔）：`agent-attention.ts` 有**两处**这样的调用
 * （整窗 rollup 与逐 Provider 汇总），所以"在场"这个问法本身就不够——把其中一处换掉，
 * 另一处仍让"在场"成立。这是变异 3 实测出来的洞：`readFileSync(...).toContain(...)`
 * 在只改一处时全绿（memory: two-write-sites-need-one-projection、
 * counting-a-symbol-misses-other-spellings）。
 *
 * 判 AST 而不是文本，理由与上面同：换行、改形参名、加空格都不该逼人改测试，而注释里的同形字符
 * 串不该冒充一次真委派。
 */
function boardColumnDelegationLines(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = []
  const callsBoardColumn = (node: ts.Expression): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'sessionBoardColumn'
  const isWorkingLiteral = (node: ts.Expression): boolean =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'working'

  const walk = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      ((callsBoardColumn(node.left) && isWorkingLiteral(node.right)) ||
        (callsBoardColumn(node.right) && isWorkingLiteral(node.left)))
    ) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return lines
}

/**
 * 每个消费者各自委派几次。取值抄自一次真扫描，不是估的。
 *
 * 钉次数而不只是钉"有没有"：把 `agent-attention.ts` 的两处之一换成内联 switch，"有没有"仍成立。
 * 这张表与 `WORKING_LITERAL_SITES` 是一对：那张问"谁自己判了"，这张问"谁委派了、委派了几次"。
 * 两张表都会因同一次改动而红，方向相反——那正是要的，一次改动应当在两侧都留下痕迹。
 *
 * 这张表守的**只是**"那次调用还在源码里"，不是"它还改变结果"：给某处接上 `&& false`，调用位仍在，
 * 次数也不变，本表照旧绿。买那一侧的是行为层，且三处都真有人跑（各自 `&& false` 实测都红）：
 * `agent-attention.ts` 两处由本文件下面逐态那几条 + provider rollup 那条盯着，
 * `fanout-group.ts` 由 `fanout-group.test.ts` 的 `groupProgress` 用例盯着，
 * `project-board.ts` 的 `workingAgentCount` 就是本文件全篇的被测对象。删掉行为层那些用例时，
 * 这张表不会替它们报警——它只回答"委派还在不在"。
 */
const BOARD_COLUMN_DELEGATIONS: Readonly<Record<string, number>> = {
  // 整窗 rollup（`:59`）与逐 Provider 汇总（`:97`）各一次。
  '/lib/agent-attention.ts': 2,
  // `workingAgentCount`。裁决点本身那个 switch 不算委派，它就是被委派的那一方。
  '/lib/project-board.ts': 1,
  // `groupProgress`。
  '/lib/fanout-group.ts': 1
}

/**
 * 一个文件里所有**出现字符串 `'working'` 的取值位**的行号（同一行出现两次就记两次）。
 *
 * 与上面那个检测器的关系是分工，不是重叠：那个问"有没有拿 `.state` 比 `'working'`"，只认二元比较，
 * 于是 switch/`.includes`/中间变量/解构四种拼法全看不见（各自在自检里钉住了）。这个只问"这个词在
 * 取值位出现了吗"，对拼法完全免疫，代价是无辜命中多——所以它配的是一张逐文件带理由的表，而不是
 * 一句"不许出现"。
 *
 * 走 AST 而不是文本：注释与文档里的 `'working'` 不该逼人更新豁免表（自检里有反向断言）。
 * `NoSubstitutionTemplateLiteral` 一并认，否则改成反引号就绕过。
 */
function workingLiteralLines(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = []
  const walk = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === 'working'
    ) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return lines
}

/**
 * 全仓每一处写着 `'working'` 的取值位，按文件记，各带一句「你回答哪个问题」。
 *
 * `count` 是那个文件里的出现次数，一起钉住：只比文件集合的话，在已列出的文件里再抄一份判据会静默
 * 通过，而那恰好是最可能发生的一种（memory: equivalence-cannot-catch-a-fresh-copy）。
 *
 * 这张表比 `NON_COUNT_STATE_COMPARISONS` 宽得多，因为它的检测器与拼法无关：那张表只收"拿 state 比
 * working"的位置，这张表收一切出现。两张表刻意不合并——它们的谓词不同，合并就得取交集或并集，
 * 两者都会让某一侧的判据失去特异性。
 */
const WORKING_LITERAL_SITES: Readonly<Record<string, { count: number; why: string }>> = {
  // ---- 唯一的裁决点，以及它的三个调用方 ----
  '/lib/project-board.ts': {
    count: 4,
    why: '裁决点本身：列名常量、switch 的 case 与返回值、workingAgentCount 读它的返回值'
  },
  '/lib/agent-attention.ts': { count: 2, why: '整窗 rollup 与逐 Provider 汇总，两处都读裁决点的返回值' },
  '/lib/agent-tree.ts': {
    count: 2,
    why: 'AgentTreeFilter union 的 "working" 成员 + working 那一支委派给 sessionBoardColumn(...) === "working"；状态栏计数树按此收窄，不自己判"在跑吗"'
  },
  '/lib/fanout-group.ts': { count: 1, why: 'groupProgress 读裁决点的返回值（曾是严格判据，见文件内注释）' },

  // ---- 与"有几个在干活"无关的问题 ----
  '/lib/composer-submit-mode.ts': {
    count: 1,
    why: '主按钮 Stop/Send：问"有在途回合吗"。idle-running 没有可打断的回合，故严格判 working 是对的'
  },
  '/lib/attention-event.ts': {
    count: 6,
    why: 'AttentionSortClass union 的成员名 + statusDotTier 的 working 档（返回类型与判定各一次）+ attentionSortClass 的 case 与返回值 + categoryFor 的 case：这个文件是"一个状态归哪一档"的裁决点，画点、排序、注意力三问各一份，都不数总量。名册行、fan-out lane、快速切换、活动列表此前各手抄一份，画点那批把 running 塌成 null（计数说 working、点画静止灰），排序那批把第十个状态默默塌成 idle。categoryFor 那一处是把 if 链改成穷举 switch 时新增的：它此前以 return null 收尾，是四个状态映射里唯一对第十个状态静默的一个'
  },
  '/lib/surface-tool-dock.ts': { count: 1, why: 'dock 分组 id 的字面量，与状态同名但是另一个命名空间' },
  '/lib/api.ts': { count: 1, why: 'browser preview 的 mock 数据，不是生产状态写入路径' },

  // ---- 单行/单 lane 的状态点：不是计数，但各有已记录的分岔 ----
  // `/components/AgentRoster.tsx` 与 `/components/FanOutStrip.tsx` 曾各占一条（各 3 次，理由都写着
  // 「单行/单 lane 状态点」）。两处的四行判定已合并进 `attention-event.ts` 的 statusDotTier，组件里
  // 一个 working 字面量都不剩，所以条目删掉——留着就是守着空地的豁免（本文件对 ProjectActivity
  // 与 fanout-group 做过同样的清理，理由见上面那两段注释）。
  '/components/ProjectActivity.tsx': {
    count: 1,
    why: 'switch 的 "working" case（"Working · no recent summary"）：问"这一个 Session 在 working 吗"。逐行 "active now" 那处已搬到 project-activity-row.ts，计数走同文件已 import 的 workingAgentCount'
  },
  '/lib/project-activity-row.ts': {
    count: 1,
    why: '单行尾随事实：working 的行尾随 ctx N%／active now，其余尾随 idle 时长。委派给 sessionBoardColumn(...) === "working"，不自己判"在跑吗"'
  },
  '/lib/session-recency.ts': {
    count: 1,
    why: 'ACTIVE_STATES 里的成员名：判一条**已完成**的 tool_call 算不算「最近」，问的是"这一个 Session 还活着吗"而不是"有几个在干活"'
  },
  '/lib/activity-groups.ts': {
    count: 2,
    why: '组排序的 working 档实参两处；组是否在跑走 workingAgentCount(...) > 0，不自己数。单 Session 那两处曾各写一份 `=== working ? working : idle`（共 4 个字面量），已委派给 attentionSortClass'
  },
  '/lib/resource-usage-panel.ts': {
    count: 1,
    why: '单行资源用量的 idle 标签：working 显示空、其余显示 idle 时长，问的是"这一个在跑吗"而不是"有几个在干活"'
  },
  '/components/AgentStatusBar.tsx': {
    count: 6,
    why: 'StatusCount 的状态词与 label（读 rollup 算好的数，自己不判）+ working 段那个 AgentTreePanel 的 filter="working" 实参'
  }
}

describe('「有几个在干活」的裁决只有一处', () => {
  const files = tsFilesUnder(rendererRoot)

  it('自检：扫描面非空，且包含那两个当事文件', () => {
    // 扫描根写错时下面那条会在空集上恒绿（#511 的形状）。
    expect(files.length, '渲染层扫描面为空——扫描根写错了').toBeGreaterThan(50)
    expect(files).toContain(boardPath)
    expect(files).toContain(attentionPath)
  })

  it('自检：检测器认得 `state === working` 的三种拼法，且不误伤读返回值的比较', () => {
    // 检测器若整体失明，下面两条就是靠失明换来的绿。
    const probe = ts.createSourceFile(
      'probe.ts',
      [
        "const a = session.status.state === 'working'",
        "const b = 'working' === session.status.state",
        "const c = session.status['state'] !== 'working'",
        // 以下三种都不该命中：读 sessionBoardColumn 的返回值、读别的成员、读别的字面量。
        "const d = column === 'working'",
        "const e = session.status.kind === 'working'",
        "const f = session.status.state === 'waiting'"
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    expect(
      stateEqualsWorkingSites(probe),
      '检测器漏了某种拼法，或误伤了读返回值的合法比较'
    ).toEqual([1, 2, 3])
  })

  it('自检：这个检测器看不见的三种拼法，逐个钉住（它的视野是它自称的那么窄）', () => {
    // 上一条只列了它**认得**的三种和它**该放过**的三种。它真正看不见的那些，此前只写在
    // 提交 message 的「后续」段里——那正是本仓反复吃过的形状（memory:
    // comment-promises-more-than-assertion）：一条读起来像已查证的散文，没人回头核对。
    //
    // 所以把盲点做成断言，落在失败现场。其中最后一种（switch/case）**必须**看不见：
    // `project-board.ts:95` 那个 switch 正是**正确**的裁决点，下面 `toEqual([])` 那条断言的前提
    // 就是它对本检测器不命中。把这个检测器加宽到认 case，会当场对正确代码打红。
    // 换句话说：这几个盲点不是待修的缺口，而是这个检测器的定义域——补位的是下面
    // `workingLiteralLines`（问"有没有第二份判据"，与拼法无关）与 `boardColumnDelegationLines`
    // （问"那次委派还在不在"，正向）两个检测器。
    //
    // **曾经是四种**。第二种（解构成 `const { state }` 再比）已经被补上了：检测器现在也认裸名
    // `state`，所以那条从盲点列表移进了上一条的「认得」里。补它不是顺手加宽——它是这张表所有
    // 豁免的共同旁路：把状态先存进一个叫 state 的变量，全表当场失明。补上之后立刻浮出两处一直
    // 存在却从未被登记的比较（AgentStatusBar.tsx、resource-usage-panel.ts），这两处就是它此前
    // 真的在漏东西的证据，而不是理论风险。
    const bypass = (line: string): number[] =>
      stateEqualsWorkingSites(
        ts.createSourceFile('bypass.ts', line, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      )

    // 1. 落到一个**别的**名字：比较的左侧既不是 `.state` 成员表达式，名字也不叫 state。
    expect(bypass("const s = session.status.state\nconst hit = s === 'working'")).toEqual([])
    // 2. 换成集合成员判定：根本不是二元比较。
    expect(bypass("const hit = ['working'].includes(session.status.state)")).toEqual([])
    // 3. 写成 switch：`case` 不是二元表达式。这一条的"看不见"是承重的，见上面说明。
    expect(
      bypass("switch (session.status.state) { case 'working': return 1 }"),
      '若这条开始命中，project-board.ts 的正确 switch 会被判成违规——先读上面的说明'
    ).toEqual([])

    // 反向：补进来的那一种必须真的被看见，否则上面那段「已经补上了」的叙述是句空话。
    expect(
      bypass("const { state } = session.status\nconst hit = state === 'working'"),
      '裸名 state 的比较又看不见了——这张表的每一条豁免都随之失效'
    ).toEqual([2])
  })

  it('两个计数投影自己都不判「在跑吗」，只调那一个开关', () => {
    // #582 的位点。`agent-attention.ts` 曾在这里写 `state === 'working'`。
    // project-board.ts 里那个 switch 用 case 而非 ===，故对本检测器天然不命中；它就是唯一裁决点。
    for (const file of [attentionPath, boardPath]) {
      expect(
        stateEqualsWorkingSites(parse(file)),
        `${file.replace(rendererRoot, '')} 自己判了一次"在跑吗"——计数必须走 sessionBoardColumn`
      ).toEqual([])
    }
    // 正向：收敛后的取值真的经过那个开关，而不是换成了别的恒等写法。
    // 逐文件钉次数，不是问"在场吗"：`agent-attention.ts` 有两处委派，只换掉其中一处时
    // 「在场」照旧成立（变异 3 实测：`toContain` 在那种改法下全绿）。
    const delegations = Object.fromEntries(
      Object.keys(BOARD_COLUMN_DELEGATIONS).map((rel) => [
        rel,
        boardColumnDelegationLines(parse(join(rendererRoot, rel.slice(1)))).length
      ])
    )
    expect(
      delegations,
      '有消费者不再委派给 sessionBoardColumn 了（或多委派了一次）。若它改成自己判，' +
        '那就是 #419/#582 的第三次复发；若是真的新增/删除了一个计数面，连同 ' +
        'BOARD_COLUMN_DELEGATIONS 一起更新。'
    ).toEqual({ ...BOARD_COLUMN_DELEGATIONS })
  })

  it('全仓「拿 state 比 working」的位置没有新增（每一处都得说清自己回答哪个问题）', () => {
    const found = new Set(
      files
        .flatMap((file) => (stateEqualsWorkingSites(parse(file)).length ? [file] : []))
        .map((file) => file.replace(rendererRoot, ''))
    )
    const known = new Set(Object.keys(NON_COUNT_STATE_COMPARISONS))
    const added = [...found].filter((path) => !known.has(path)).sort()
    const gone = [...known].filter((path) => !found.has(path)).sort()

    expect(
      added,
      '这些位置新写了一份「在跑吗」的判据。若它数的是"有几个在干活"，改成调 sessionBoardColumn' +
        '（#419 收敛了一半、#582 是剩下那一半，别开第三次）；若它回答的是别的问题，' +
        '把它连同理由加进 NON_COUNT_STATE_COMPARISONS。'
    ).toEqual([])
    expect(
      gone,
      '这些位置已经不再自己判了——把它们从 NON_COUNT_STATE_COMPARISONS 删掉，' +
        '否则这张表会慢慢变成一份谁都不敢动的陈旧豁免清单。'
    ).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 补位检测器：与拼法无关。
  //
  // 上面那个检测器只认「`.state` 与 `'working'` 的二元比较」，它的四个盲点已在自检里逐条钉住，
  // 其中 switch/case 那个是**承重**的（`project-board.ts` 的正确裁决点就写成 switch）。所以加宽它
  // 是错的，补位只能换一个判据。
  //
  // 这个判据是：全仓每一处**出现字面量 `'working'` 的取值位**都必须在表里带一句"你是谁"。它对拼法
  // 完全免疫——switch 的 case、`.includes` 的数组元素、类型 union 的成员、把它当 CSS 词用的，一个
  // 都躲不掉。代价是它认得的位置多得多（12 个文件），而绝大多数是无辜的；所以表里记的是**文件**与
  // 出现次数，新增一处就要在这里说清自己回答哪个问题。
  //
  // 这不是「禁止形状不在场」那种门（memory: forbidden-shape-guard-misfires）：它不禁任何写法，只
  // 要求每处出现都被质询过一次。次数一起钉住，否则在已列出的文件里再抄一份会静默通过——那恰好是
  // 最可能发生的一种（memory: equivalence-cannot-catch-a-fresh-copy）。
  // -------------------------------------------------------------------------
  it('自检：这个检测器对拼法免疫（switch/includes/中间变量都认得）', () => {
    const count = (source: string): number =>
      workingLiteralLines(
        ts.createSourceFile('p.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      ).length
    // 上一个检测器的四个盲点，这里逐个必须命中——这就是"补位"这两个字的内容。
    expect(count("const s = session.status.state\nconst hit = s === 'working'"), '中间变量').toBe(1)
    expect(count("const { state } = session.status\nif (state === 'working') f()"), '解构').toBe(1)
    expect(count("const hit = ['working'].includes(state)"), '集合成员').toBe(1)
    expect(count("switch (state) { case 'working': return 1 }"), 'switch/case').toBe(1)
    // 反向：不含这个字面量的文件必须是 0，否则它对一切都命中，表里的次数就不是证据。
    expect(count("const hit = state === 'waiting'"), '不该对别的字面量命中').toBe(0)
    // 注释里的词不算：判的是取值位，不是文本。否则每次改注释都要动这张表。
    expect(count("// 这里讲的是 'working' 列\nconst n = 1"), '注释不算取值位').toBe(0)
  })

  it('每一处写着 working 的取值位都被质询过（次数一起钉住）', () => {
    const found = new Map<string, number>()
    for (const file of files) {
      const hits = workingLiteralLines(parse(file)).length
      if (hits) found.set(file.replace(rendererRoot, ''), hits)
    }
    const known = new Map(Object.entries(WORKING_LITERAL_SITES).map(([path, site]) => [path, site.count]))

    // 一条断言，不是三条。整张表的相等判断**已经蕴含**「没有新文件」与「没有过期条目」——
    // 键集不同时 toEqual 就红，并把两边的表都打印出来，定位信息不比分开写少。
    //
    // 曾经写成三条 expect 依次排列（新增集 → 过期集 → 计数表），实测那是一个**互相掩盖**的结构：
    // 同一个 it 里前一条抛出后，后面两条是死代码。于是 AgentStatusBar.tsx 的计数从 4 漂到 5 一直
    // 没被发现——每次有人新增文件，第一条先红，计数那条根本没跑；等新增集被补齐了，计数那条才
    // 第一次执行，而那时它报的是一个「早就漂了」的旧账，看起来像本次改动引入的。
    //
    // 收成一条之后，三种放宽（新增文件 / 删掉条目 / 在已列出的文件里再抄一份）都由同一条断言接住，
    // 谁也挡不住谁。（memory: two-throws-in-one-it-mask-each-other 的同族——那条讲两个 toThrow，
    // 这里是两个 toEqual，机制一样：先抛的那个让后面的永不执行。）
    expect(
      Object.fromEntries([...found].sort()),
      '全仓 `working` 字面量的分布与 WORKING_LITERAL_SITES 不一致。三种情况：' +
        '(1) 某个文件新写了 `working`——若它数的是"有几个在干活"，改成调 sessionBoardColumn；' +
        '否则把它连同"你回答哪个问题"加进表里。' +
        '(2) 某个文件已经不写了——从表里删掉，别留陈旧豁免。' +
        '(3) 已列出的文件里出现次数变了——多出来的那一处是不是又抄了一份判据？'
    ).toEqual(Object.fromEntries([...known].sort()))
  })
})
