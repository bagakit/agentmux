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
// 为什么这个分岔必然显形、而不是理论上的：`running` 不是边角状态而是**主稳态**——`api.ts` 在启动与
// attach 时就写它，`agent-status-freshness` 的 15 分钟静默衰减把 `unknown` 映射成它
// （`decayedDisplayState`）。所以严格判据的稳定结论就是"一个都没在跑"，恰好是用户看到的 0。
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
 * 刻意不从 `AGENT_DISPLAY_STATES` 派生：期望值若由被测对象算出，就会跟着变异一起漂而恒真
 * （memory: expected-value-must-not-derive-from-mutation-target）。自检 1 再把这份手抄与运行期
 * 真相对上，所以漂移会红在那里，而不是让下面每条断言在一个错的参照上比对。
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
  '/lib/agent-roster.ts': '行排序 rank，喂给 attentionSortRank',
  '/lib/fanout-group.ts': '单个 fan-out 组内的 lane 分桶，作用域是那一组而非整窗'
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
    expect(readFileSync(attentionPath, 'utf8')).toContain("sessionBoardColumn(session) === 'working'")
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
})
