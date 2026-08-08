import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// api 在模块加载时就要判断跑在哪个宿主里；不先立起这个全局，import 阶段就炸。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    providerCatalog: [] as unknown[],
    selectSession: vi.fn(),
    reportError: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'
import { RosterRowView } from '../src/renderer/src/components/AgentRoster.js'
import { buildAgentRoster } from '../src/renderer/src/lib/agent-roster.js'
import { AGENT_DISPLAY_STATES } from '../src/renderer/src/lib/attention-vocabulary.js'
import { attentionAccentFor } from '../src/renderer/src/lib/attention-event.js'
import { allStyleRules } from './helpers/styles.js'

// AgentMux 的整个存在理由是告诉用户「哪个 Agent 在等你」。这枚头像是那个信号在 Topic 行与 Branch 行
// 上的唯一载体。这一族守的是一整族被真实变异证实过的空洞（变异施加后全仓照旧全绿）：
//
//   1. 头像**根本画不出** waiting/blocked/error——等你的 Agent 与 idle 逐像素同款。
//   2. 那条注意力判断能被改成常量 false 而无人变红。
//   3. 头像的正确性曾取决于两个 prop（state + attention）是否自洽——任一调用方递一对不一致的值，
//      就静默画错。这是 1/2/4 的病根：组件收的是**派生后的一对**，而不是那一个权威值。
//   4. Branch 侧的头像永远画不出 needs-you，且对同一个问题与 Topic 侧答得相反。
//   5. AgentRoster 的 stateFor 在 DOM 层从不执行——error 能被画成绿而无人变红。
//
// 修法：头像只收 `state` 这一个权威输入，`data-attention` 一律由 `attentionAccentFor(state)` 内部
// 派生（那是「哪些状态该抢琥珀/红」的 SSOT，其 needs-you 半来自 attention-vocabulary.ts）。不自洽的
// 组合从类型上就构造不出来——没有第二个 prop 可以与 state 漂开。
//
// 判据全部**真渲染**：源码文本断言（readFileSync+toContain）不执行代码，函数头插一句早退就能让实现
// 变 no-op 而守卫照旧绿；本仓栽过多次。renderToStaticMarkup 不跑 effect，但头像与 stateFor 都是
// 纯渲染期计算，够得着。

/** AgentAvatar 单枚渲染，去掉 provider 图标的 svg 内脏以便按属性断言。 */
function avatarMarkup(state: AgentDisplayState): string {
  return renderToStaticMarkup(
    createElement(AgentAvatar, { label: 'agent-x', onOpen: () => {}, providerId: 'codex', state })
  ).replace(/<svg[\s\S]*?<\/svg>/u, '<svg/>')
}

/** 一枚头像上那些**能被 CSS 用来区分外观**的信号：状态类、data-attention。 */
function visualSignals(markup: string): { statusClass: string; attention: string | null } {
  const statusClass = /class="[^"]*\b(status--[a-z]+)\b[^"]*"/u.exec(markup)?.[1] ?? ''
  const attention = /data-attention="([^"]+)"/u.exec(markup)?.[1] ?? null
  return { statusClass, attention }
}

// 一枚头像真正**画出来**的样子，从真实样式表反推——而不是拿那个每状态都唯一的 `status--<state>`
// 当签名。后者对每个状态天然不同，用它判「各有可辨外观」是恒真的假绿（本仓明令禁止的那种）：
// 状态类改成常量、把描边规则删掉，它照样九个各不相同。
//
// 头像的像素只由三样东西决定，全部在 dock.css 的 `.agent-avatar*` 段：
//   1. 有没有一条 `.agent-avatar.status--<state>` 专属规则（只有 working/running/disconnected 有；
//      working 与 running 共用一条实线描边+glow，disconnected 是虚线描边）；
//   2. `data-attention` 的取值（needs-you / error → 实线描边 + 去灰度 + 一枚角标）；
//   3. 那枚角标 `::after` 的 `content`（needs-you 是 `?`，error 是 `!`）。
// 把这三样拼成「外观类」。故意共享外观的状态会落进同一个外观类——那是设计（见 attention-vocabulary.ts
// 的裁决表：done/exited/starting 都走基础灰度收敛，是「结束/未开始」而非「在等你」）。
function paintedAppearance(state: AgentDisplayState, styles: string): string {
  const { attention } = visualSignals(avatarMarkup(state))
  // 该状态是否有一条 `.agent-avatar.status--<state> { ... }` 专属规则，及其规则体。
  const ruleBody = (): string => {
    for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (
        selector!
          .split(',')
          .some((one) => one.trim() === `.agent-avatar.status--${state}`)
      ) {
        return body!.replace(/\s+/gu, ' ').trim()
      }
    }
    return ''
  }
  // data-attention 那枚角标的字形（needs-you=?, error=!），从真实规则里取，不手抄。
  const glyph = (): string => {
    if (attention === null) return ''
    let content = ''
    for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      // 后写的覆盖先写的（error 那条 `content:'!'` 就是这样改写掉基础的 `?`）。
      if (new RegExp(`\\.agent-avatar\\[data-attention=['"]${attention}['"]\\]::after`, 'u').test(selector!)) {
        const c = /content:\s*'([^']*)'/u.exec(body!)?.[1]
        if (c !== undefined) content = c
      }
    }
    return content
  }
  // 载体本体（非 ::after）那条 `.agent-avatar[data-attention=X] { filter/outline }` 规则的规则体——
  // 它把等你/出错的头像从灰度里拉出来并加实线描边。删掉它，等你/出错的头像会退回基础灰度块（与
  // neutral 族同款），所以它必须进签名：没有它，M3c 那种「删掉去灰度规则」不改变签名而存活。
  const accentBody = (): string => {
    if (attention === null) return ''
    let body = ''
    for (const [, selector, ruleBody] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const members = selector!.split(',').map((one) => one.trim())
      // 只认非 ::after、且点名了这个 attention 的载体规则。
      if (
        members.some((one) =>
          new RegExp(`^\\.agent-avatar\\[data-attention=['"]${attention}['"]\\]$`, 'u').test(one)
        )
      ) {
        body += ruleBody!.replace(/\s+/gu, ' ').trim()
      }
    }
    return body
  }
  // 注意：不把 `--status-ink` 折进头像外观签名。头像的**基础**态（done/exited/starting）根本不读 ink
  // （只有 working/running/disconnected 的专属规则和 [data-attention] 那两条读它），所以 exited 与 done
  // 虽然 ink 一红一蓝，画在头像上却是同一个基础灰度块——它们本就该在头像上同款。ink 的正确性由下面
  // 专门那条「颜色锚在字面量色相上」按 `.status--<state>` 直接质询，不混进这里。
  return `own-rule=${ruleBody()}|accent=${attention !== null}|accent-body=${accentBody()}|glyph=${glyph()}`
}

/**
 * 一个 `.status--<state>` 从状态语汇段拿到的 `--status-ink` 取值（该状态的**颜色**）。
 *
 * 头像的描边/角标背景都读 `--status-ink`，所以这就是「这个状态画成什么色」的唯一来源。从真实样式表
 * 反推，不手抄一份色表（手抄的会和样式表漂开且漂开时不响）。
 */
function statusInk(state: AgentDisplayState, styles: string): string {
  let value = ''
  for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (!selector!.split(',').some((one) => one.trim() === `.status--${state}`)) continue
    const assignment = /--status-ink\s*:\s*([^;}]+)/u.exec(body!)
    if (assignment) value = assignment[1]!.trim()
  }
  return value
}

describe('AgentAvatar：每个状态各有可辨的外观（症状 1）', () => {
  it('该有独立外观的状态两两可辨，故意共享的状态落进同一外观类——从真实样式表反推', () => {
    // 自检：状态清单空了下面整个循环空转。清单来自 SSOT 派生，不手抄九个名字。
    expect(AGENT_DISPLAY_STATES.length).toBeGreaterThan(0)
    const styles = allStyleRules()
    // 自检：样式表真被读到了，否则每个 appearance 都退化成同一个空壳、下面的相等/不等全失去意义。
    expect(styles).toContain('.agent-avatar')

    const appearance = new Map<AgentDisplayState, string>()
    for (const state of AGENT_DISPLAY_STATES) appearance.set(state, paintedAppearance(state, styles))

    // 头像的外观按设计分成这些**互不相同**的族。这份分组是需求（哪些状态该长一样），不是实现常量的
    // 副本：working/running 都「在场且活跃」共用实线描边+glow；waiting/blocked 都「在等你」共用琥珀
    // 描边+`?`；done/exited/starting 都「结束或未开始」走基础灰度收敛；disconnected 是「曾在」虚线；
    // error 是「坏了」红描边+`!`。
    const FAMILIES: Record<string, readonly AgentDisplayState[]> = {
      active: ['working', 'running'],
      'needs-you': ['waiting', 'blocked'],
      neutral: ['done', 'exited', 'starting'],
      disconnected: ['disconnected'],
      error: ['error']
    }
    // 分组必须覆盖整个联合——漏一个状态，它的外观就无人质询。
    expect([...Object.values(FAMILIES)].flat().sort()).toEqual([...AGENT_DISPLAY_STATES].sort())

    // 同族内：外观必须**相同**（否则「该长一样」的设计被打破，或某个状态借了不该有的记号）。
    for (const [family, states] of Object.entries(FAMILIES)) {
      const distinct = new Set(states.map((state) => appearance.get(state)!))
      expect(distinct.size, `${family} 族内出现了不同外观：${states.join('/')}`).toBe(1)
    }

    // 跨族：五个族的外观必须**两两不同**——这才是「各有可辨外观」。症状 1 的形状是 needs-you/error
    // 塌进 neutral；删掉头像里派生 attention 的那一行，needs-you 与 error 的 attention 都变 none、
    // 角标消失，两族的 appearance 都塌成 neutral，这里的 size 掉到 3，红。
    const familyAppearance = Object.entries(FAMILIES).map(([family, states]) => ({
      family,
      appearance: appearance.get(states[0]!)!
    }))
    const distinctFamilies = new Set(familyAppearance.map((f) => f.appearance))
    expect(
      distinctFamilies.size,
      `五个外观族里有两族被画成了同一样子：${JSON.stringify(familyAppearance)}`
    ).toBe(Object.keys(FAMILIES).length)
  })

  it('颜色锚在字面量色相上：error 是红、needs-you 是琥珀、working 是绿（颜色互换变异）', () => {
    // 上面那条「五族两两不同」抓不住**互换**：把 error 与 needs-you 的色相对调，两个取值仍彼此不同，
    // 族与族照旧可辨。所以这里把每族的色相钉在**字面量** token 上——不是「互不相同」，是「就得是这个」。
    // 把 chrome.css 状态语汇段里 `.status--error` 的 `--status-ink` 从 `var(--red)` 换成 `var(--amber)`，
    // 这条立刻红（error 行现在读出的是琥珀）。红说「坏了」、琥珀说「你被等着」，本仓已经修过两次把
    // error 画成琥珀的缺陷。
    const styles = allStyleRules()
    expect(statusInk('error', styles), 'error 不是红了——「坏了」被画成别的意思').toBe('var(--red)')
    expect(statusInk('exited', styles), 'exited 也该是红（进程非正常离开）').toBe('var(--red)')
    expect(statusInk('waiting', styles), 'waiting 不是琥珀了——「等你」被改色').toBe('var(--amber)')
    expect(statusInk('blocked', styles), 'blocked 不是琥珀了').toBe('var(--amber)')
    expect(statusInk('working', styles), 'working 不是绿了').toBe('var(--green)')
    expect(statusInk('running', styles), 'running 不是绿了').toBe('var(--green)')
    expect(statusInk('done', styles), 'done 不是蓝了').toBe('var(--blue)')
    // 自检：色相各不相同，否则上面几条可能同时指向同一个恒定值而失去意义。
    expect(new Set([
      statusInk('error', styles),
      statusInk('waiting', styles),
      statusInk('working', styles),
      statusInk('done', styles)
    ]).size).toBe(4)
  })

  it('颜色不是唯一信号：error 与 needs-you 的角标字形不同（色盲/快速扫视）', () => {
    // 一摞 18px 方块里，只靠描边色分辨琥珀与红在色盲和快速一扫下都不成立，所以两者的 `::after` 角标
    // 必须是**不同字形**（needs-you=`?`, error=`!`）。把 error 那条 `content:'!'` 改回 `'?'`，这条红。
    const styles = allStyleRules()
    const glyphOf = (attention: string): string => {
      let content = ''
      for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        if (new RegExp(`\\.agent-avatar\\[data-attention=['"]${attention}['"]\\]::after`, 'u').test(selector!)) {
          const c = /content:\s*'([^']*)'/u.exec(body!)?.[1]
          if (c !== undefined) content = c
        }
      }
      return content
    }
    const needsYou = glyphOf('needs-you')
    const error = glyphOf('error')
    // 自检：两个字形都真的取到了，否则下面的不等是空对空。
    expect(needsYou.length, 'needs-you 角标字形没取到').toBeGreaterThan(0)
    expect(error.length, 'error 角标字形没取到').toBeGreaterThan(0)
    expect(error, 'error 与 needs-you 用了同一枚字形，色盲下读不出区别').not.toBe(needsYou)
  })

  it('needs-you / error 的头像被拉出灰度并加实线描边——不只是挂个角标（症状 1 的载体规则）', () => {
    // #409 那条载体规则（`.agent-avatar[data-attention='needs-you'], [data-attention='error']`）负责把
    // 等你/出错的头像 `filter: none; opacity: 1` 从灰度里拉出来、并加一圈实线 outline。删掉它，等你/
    // 出错的头像退回灰度块——角标还在，但整枚方块灰蒙蒙，「有人在等你」这唯一提示被灰掉了。可达性
    // 判据：同一条选择器里既点名 `.agent-avatar` 又点名这个取值（#397 的形状是「类被样式、属性在别处
    // 被样式、这一对没人样式」）。
    const styles = allStyleRules()
    for (const attention of ['needs-you', 'error'] as const) {
      const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
        .map(([, selector, body]) => ({ selector: selector!.replace(/\s+/gu, ' ').trim(), body: body! }))
        .filter(({ selector }) =>
          // 非 ::after 的载体规则：点名 .agent-avatar 与这个取值，且不是伪元素。
          new RegExp(`\\.agent-avatar\\[data-attention=['"]${attention}['"]\\](?!::)`, 'u').test(selector) &&
          !selector.includes('::after')
        )
      expect(rules.length, `${attention} 没有载体规则把头像拉出灰度`).toBeGreaterThan(0)
      const pulled = rules.some(({ body }) => /filter:\s*none/u.test(body))
      const outlined = rules.some(({ body }) => /outline:[^;]*solid/u.test(body))
      expect(pulled, `${attention} 的头像没有 filter:none——仍是灰度块`).toBe(true)
      expect(outlined, `${attention} 的头像没有实线描边`).toBe(true)
    }
  })

  it('waiting / blocked / error 各自画出自己的注意力口径（症状 1/2）', () => {
    // 逐状态钉死那个**计算出来**的 data-attention。把头像里的三元/派生改成常量 false（或删掉），
    // 这三条各自红。锚点是字面量，不从被测代码算出来。
    expect(visualSignals(avatarMarkup('waiting')).attention).toBe('needs-you')
    expect(visualSignals(avatarMarkup('blocked')).attention).toBe('needs-you')
    expect(visualSignals(avatarMarkup('error')).attention).toBe('error')
  })

  it('不该抢注意力的状态一律不带 data-attention（症状 2 的另一侧）', () => {
    // 把派生条件改成常量 **true**（恒发属性）时，这些状态会冒出一个没人接的取值——这条红。
    for (const quiet of ['starting', 'running', 'disconnected', 'working', 'done', 'exited'] as const) {
      expect(
        visualSignals(avatarMarkup(quiet)).attention,
        `${quiet} 冒出了 data-attention——它不该抢琥珀/红`
      ).toBeNull()
    }
  })

  it('头像的注意力口径逐状态等于共享 SSOT，而不是自己判一份（症状 3 的收敛）', () => {
    // 上面钉的是取值域；这条钉「谁说的」。取值域对而映射错（比如把 error 也说成 needs-you）在上面
    // 那几条下仍可能存活，所以逐状态与 attentionAccentFor 对齐——那是唯一裁决处。
    for (const state of AGENT_DISPLAY_STATES) {
      expect(visualSignals(avatarMarkup(state)).attention, state).toBe(attentionAccentFor(state))
    }
  })
})

describe('AgentAvatar：无法用一对不自洽的输入把它调错（症状 3）', () => {
  it('组件只收 state 这一个权威输入——没有第二个 prop 能与它漂开', () => {
    // 从前签名是 { attention, state }：调用方对同一个 state 递不同的 attention，头像照单全收，于是
    // 「waiting 画成 idle」得以静默发生。现在把「有效输入」逐个渲染，证明每个 state 都自己算出了对的
    // 口径——不依赖任何调用方递进来的 attention。
    //
    // 这条同时也是「有效形状仍能正确渲染」的证明：tsc 保证不再有 attention 参数可传（多传一个
    // 会编译错），但 tsc 不告诉你渲染对不对，所以这里对每个 state 都真渲染并按 SSOT 校验。
    for (const state of AGENT_DISPLAY_STATES) {
      const { statusClass, attention } = visualSignals(avatarMarkup(state))
      expect(statusClass, `${state} 没渲染出状态类`).toBe(`status--${state}`)
      expect(attention, `${state} 的注意力口径与 SSOT 不一致`).toBe(attentionAccentFor(state))
    }
  })
})

// ---- 症状 5：AgentRoster.stateFor 必须在 DOM 层被执行 ----
//
// 单测 stateFor 本身不闭合这个洞——洞正是「这个函数在 DOM 层从不执行」。所以必须真渲染那个用到它的
// 行组件，并断言行上的状态点类名。AgentRoster 把行包在**默认关闭**的 Radix DropdownMenu 里，
// renderToStaticMarkup 渲不出关闭的 Content；用 open + Content forceMount（不套 Portal，Portal 在
// SSR 下渲空）把行逼出来，stateFor 就在渲染期真的执行到了。
//
// 不重建行的 JSX——那会变成第二份实现的自证。渲染的是真的 RosterRowView，行内部就是那句
// `const state = stateFor(row)` 与 `status status--${state}`。

function agent(id: string, state: AgentDisplayState): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

/** 把一个给定状态的 Agent 建成 RosterRow，经强制展开的菜单渲染其行，取状态点那个 span 的 class。 */
function rosterDotClass(state: AgentDisplayState): string {
  const rows = buildAgentRoster({ sessions: [agent('a', state)], providerCatalog: [] })
  expect(rows.length, `buildAgentRoster 没造出行——判据落空`).toBe(1)
  const markup = renderToStaticMarkup(
    createElement(
      DropdownMenu.Root,
      { open: true },
      createElement(
        DropdownMenu.Content,
        { forceMount: true },
        createElement(RosterRowView, { row: rows[0]!, onSelect: () => {}, reportError: () => {} })
      )
    )
  )
  // 状态点是行里第一个 `class="status..."` 的 span。stateFor 返回 null 时它只有基类 `status`
  // （中性点）；返回某个状态时是 `status status--<state>`。
  const cls = /class="(status(?:\s+status--[a-z]+)?)"/u.exec(markup)?.[1]
  expect(cls, `${state} 行里没渲染出状态点 span——判据落空`).toBeDefined()
  return cls!
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.selectSession.mockClear()
  fixture.state.reportError.mockClear()
})

describe('AgentRoster.stateFor 在 DOM 层真的执行（症状 5）', () => {
  it('stateFor 的四个分支各自到达状态点的 class，error 不被画成 working/waiting', () => {
    // waiting → 'waiting'、error → 'error'、working → 'working'、其余（done…）→ null（中性点）。
    // 这四条锚在字面量 class 上，不从 stateFor 反算。若 stateFor 的结果没被用到（行里写死一个常量
    // class、或状态点不读它、或函数被 return 常量），下面任一条都红——因为渲染出的 class 会与锚点不符。
    expect(rosterDotClass('waiting')).toBe('status status--waiting')
    expect(rosterDotClass('error')).toBe('status status--error')
    expect(rosterDotClass('working')).toBe('status status--working')
    // done：stateFor 返回 null，点保持中性（只有基类，无状态类）。
    expect(rosterDotClass('done')).toBe('status')
  })

  it('needs-you / error / working / 中性 四种点两两可辨', () => {
    // 只钉某一个分支时，把另外几个折成它也照样绿；所以要求四种彼此不同。
    const classes = [
      rosterDotClass('waiting'),
      rosterDotClass('error'),
      rosterDotClass('working'),
      rosterDotClass('done')
    ]
    expect(new Set(classes).size, '有两个 stateFor 分支画成了同一个点').toBe(4)
  })

  it('error 状态的点绝不落到 working 的绿类上（颜色反转变异）', () => {
    // 直接对位「把 error 说成 working」这类变异：error 行的点必须是 error 类，且不是 working 类。
    const errorDot = rosterDotClass('error')
    expect(errorDot).toContain('status--error')
    expect(errorDot, 'error 被画成了 working 的绿').not.toContain('status--working')
  })
})

