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
 * 这里刻意不 import 一个运行期常量数组——**没有那个东西**：core 只导出类型，全仓
 * `AGENT_DISPLAY_STATES` 零命中。此前打算写的那条 `toEqual([...AGENT_DISPLAY_STATES])` 会引一个
 * 不存在的名字。而 union 是编译期的，所以锚点只能靠 parse 那个类型别名取到，见
 * `displayStateUnionMembers`。
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
 * 为什么要 parse 而不是 import：core **只导出类型**，全仓没有任何 `AGENT_DISPLAY_STATES` 之类的运行期
 * 数组（实测 0 命中）。union 是编译期的，所以想让本文件手抄的九个态有一个**外部**锚点，只能取那个
 * 类型别名本身。此前打算写的 `toEqual([...AGENT_DISPLAY_STATES].sort())` 会引一个不存在的名字。
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
  // 拿不到就抛，不返回空数组：空数组会让下面的比对退化成"两个空集相等"而恒真。
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
  // 单行/单 lane 的状态点，不是计数。它们与计数分岔属于另一族（roster 行 #500、lane 措辞 #572），
  // 各有自己的条目，不在本次收敛范围内——但它们出现在这里，所以不会被静默遗忘。
  '/components/AgentRoster.tsx': '单行状态点（另见 #500：该函数在 DOM 层从未被执行）',
  '/components/FanOutStrip.tsx': '单 lane 状态点（另见 #572）',
  '/lib/agent-roster.ts': '行排序 rank，喂给 attentionSortRank'
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
  const readsStateMember = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === 'state') ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'state')
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
        ((readsStateMember(node.left) && isWorkingLiteral(node.right)) ||
          (readsStateMember(node.right) && isWorkingLiteral(node.left)))
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
  '/lib/fanout-group.ts': { count: 1, why: 'groupProgress 读裁决点的返回值（曾是严格判据，见文件内注释）' },

  // ---- 与"有几个在干活"无关的问题 ----
  '/lib/composer-submit-mode.ts': {
    count: 1,
    why: '主按钮 Stop/Send：问"有在途回合吗"。idle-running 没有可打断的回合，故严格判 working 是对的'
  },
  '/lib/attention-event.ts': { count: 1, why: 'AttentionSortClass union 的成员名，是排序类而非状态' },
  '/lib/surface-tool-dock.ts': { count: 1, why: 'dock 分组 id 的字面量，与状态同名但是另一个命名空间' },
  '/lib/quick-switch.ts': {
    count: 2,
    why: 'attentionRank 的 switch：把状态映射到排序类，case 与 attentionSortRank 的实参各一次'
  },
  '/lib/api.ts': { count: 1, why: 'browser preview 的 mock 数据，不是生产状态写入路径' },

  // ---- 单行/单 lane 的状态点：不是计数，但各有已记录的分岔 ----
  '/lib/agent-roster.ts': { count: 2, why: '行排序 rank，喂给 attentionSortRank（另见 #572）' },
  '/components/AgentRoster.tsx': { count: 3, why: '单行状态点（另见 #500：该函数在 DOM 层从未被执行）' },
  '/components/FanOutStrip.tsx': { count: 3, why: '单 lane 状态点（另见 #572）' },
  '/components/AgentStatusBar.tsx': {
    count: 4,
    why: 'StatusCount 的状态词与 label：读 rollup 算好的数，自己不判'
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

  it('自检：这个检测器看不见的四种拼法，逐个钉住（它的视野是它自称的那么窄）', () => {
    // 上一条只列了它**认得**的三种和它**该放过**的三种。它真正看不见的那些，此前只写在
    // 提交 message 的「后续」段里——那正是本仓反复吃过的形状（memory:
    // comment-promises-more-than-assertion）：一条读起来像已查证的散文，没人回头核对。
    //
    // 所以把盲点做成断言，落在失败现场。其中第四种（switch/case）**必须**看不见：
    // `project-board.ts:95` 那个 switch 正是**正确**的裁决点，下面 `toEqual([])` 那条断言的前提
    // 就是它对本检测器不命中。把这个检测器加宽到认 case，会当场对正确代码打红。
    // 换句话说：这四个盲点不是待修的缺口，而是这个检测器的定义域——补位的是下面
    // `workingLiteralLines`（问"有没有第二份判据"，与拼法无关）与 `boardColumnDelegationLines`
    // （问"那次委派还在不在"，正向）两个检测器。
    const bypass = (line: string): number[] =>
      stateEqualsWorkingSites(
        ts.createSourceFile('bypass.ts', line, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      )

    // 1. 先落到中间变量：比较的左侧不再是 `.state` 成员表达式。
    expect(bypass("const s = session.status.state\nconst hit = s === 'working'")).toEqual([])
    // 2. 解构出来：同上，且连 `.state` 这个词都不在比较那一行。
    expect(bypass("const { state } = session.status\nconst hit = state === 'working'")).toEqual([])
    // 3. 换成集合成员判定：根本不是二元比较。
    expect(bypass("const hit = ['working'].includes(session.status.state)")).toEqual([])
    // 4. 写成 switch：`case` 不是二元表达式。这一条的"看不见"是承重的，见上面说明。
    expect(
      bypass("switch (session.status.state) { case 'working': return 1 }"),
      '若这条开始命中，project-board.ts 的正确 switch 会被判成违规——先读上面的说明'
    ).toEqual([])
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

    expect(
      [...found.keys()].filter((path) => !known.has(path)).sort(),
      '这些文件新写了 `working` 字面量。若它数的是"有几个在干活"，改成调 sessionBoardColumn；' +
        '否则把它连同"你回答哪个问题"加进 WORKING_LITERAL_SITES。'
    ).toEqual([])
    expect(
      [...known.keys()].filter((path) => !found.has(path)).sort(),
      '这些文件已经不写 `working` 了——从 WORKING_LITERAL_SITES 删掉，别留陈旧豁免。'
    ).toEqual([])
    // 次数：已列出的文件里再抄一份，上面两条都不会红。
    expect(
      Object.fromEntries([...found].sort()),
      '某个文件里 `working` 的出现次数变了。多出来的那一处是不是又抄了一份判据？' +
        '确认它回答的是别的问题之后，更新 WORKING_LITERAL_SITES 里的 count。'
    ).toEqual(Object.fromEntries([...known].sort()))
  })
})
