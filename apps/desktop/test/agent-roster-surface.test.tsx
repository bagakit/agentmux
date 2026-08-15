import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 这条 surface 现在（经 AgentStatusBar）连着资源面板，而资源面板要读 api，api 在模块加载时
// 就要判断跑在哪个宿主里。不先立起这个全局，import 阶段就炸，测的什么都还没跑到。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentCatalogEntry } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { buildAgentRoster } from '../src/renderer/src/lib/agent-roster.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    providerCatalog: [] as AgentCatalogEntry[],
    selectSession: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import * as DropdownMenu from '../src/renderer/src/components/HoverDropdownMenu.js'
import { AgentRoster, RosterRowView } from '../src/renderer/src/components/AgentRoster.js'
import { AgentStatusBar } from '../src/renderer/src/components/AgentStatusBar.js'

function agent(
  id: string,
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): SessionSnapshot {
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
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  } as unknown as SessionSnapshot
}

function catalogEntry(): AgentCatalogEntry {
  return {
    id: 'codex',
    label: 'Codex',
    launchOptions: [
      {
        id: 'sandbox',
        label: 'Sandbox',
        choices: [
          { id: 'read-only', label: 'Read only', tier: 'safe' },
          { id: 'danger-full-access', label: 'Danger full access', tier: 'danger' }
        ]
      }
    ]
  } as unknown as AgentCatalogEntry
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.providerCatalog = []
  fixture.state.selectSession.mockClear()
})

describe('agent roster surface', () => {
  it('costs only the count that was already on the bar until it is opened', () => {
    // Collapsed is a trigger carrying the same total the bar showed before; the list is not rendered.
    fixture.state.sessions = [agent('a'), agent('b')]
    const markup = renderToStaticMarkup(createElement(AgentRoster, { total: 2 }))

    expect(markup).toContain('agent-roster__trigger')
    expect(markup).toContain('>2<')
    // Radix keeps the content unmounted while closed, so no row and no heading are in the DOM.
    expect(markup).not.toContain('agent-roster__row')
    expect(markup).not.toContain('Agents in this window')
  })

  it('does not render at all when the window projects no Agent', () => {
    expect(renderToStaticMarkup(createElement(AgentRoster, { total: 0 }))).toBe('')
  })

  it('keeps the enumerable Agents roster in the left workspace tool, not the Status Bar', () => {
    fixture.state.sessions = [agent('a')]
    const markup = renderToStaticMarkup(createElement(AgentStatusBar))

    expect(markup).not.toContain('agent-roster__trigger')
    // The Status Bar remains a compact cross-window summary.
    expect(markup).toContain('agent-status-bar')
    expect(markup).toContain('status__dot')
  })

  it('names the count in the trigger label so a reader gets the fact, not just a control', () => {
    fixture.state.sessions = [agent('a'), agent('b'), agent('c')]
    const markup = renderToStaticMarkup(createElement(AgentRoster, { total: 3 }))

    expect(markup).toContain('3 agents in this window')
    // Singular reads correctly too.
    fixture.state.sessions = [agent('a')]
    expect(renderToStaticMarkup(createElement(AgentRoster, { total: 1 })))
      .toContain('1 agent in this window')
  })

  it('keeps the bar rendering nothing when the window holds no Agent Session', () => {
    // The bar's existing contract: it occupies no space at all rather than showing an empty rollup.
    expect(renderToStaticMarkup(createElement(AgentStatusBar))).toBe('')
  })
})

describe('上下文压力标记出现在名册行上', () => {
  // 这是第三道，与另外两道各守一层：判定（agent-usage-display）→ 投影（agent-roster）→ 这里的**渲染**。
  // 前两道全绿而这里缺席，界面上就什么都看不到；本仓反复栽在「纯函数有人守、JSX 无人守」这个形状上。

  function withContext(id: string, usedTokens: number, capacityTokens: number): SessionSnapshot {
    return agent(id, {
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'observe',
        providerResume: true, replyCorrelation: 'none',
        usage: { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }
      },
      turnUsage: {
        inputTokens: 1, outputTokens: 1, totalTokens: 2, observedAt: 5,
        context: { usedTokens, capacityTokens }
      }
    } as unknown as Partial<Extract<SessionSnapshot, { kind: 'agent' }>>)
  }

  /**
   * 渲染这些 Session 对应的名册**行**。
   *
   * 刻意不给 `AgentRoster` 加一个只为测试而存在的 `open` 形参：Radix 的 DropdownMenu 关着时不挂载
   * 内容，但为测试改生产组件的签名，是把测试的便利算进产品的复杂度。`RosterRowView` 本来就是导出的，
   * 行内容全在它里面——它是个 `DropdownMenu.Item`，所以这里补上它所需的最小 Radix 上下文
   * （Root + Portal 之外的 Content 需要 open 与 forceMount 才会在 SSR 里出现）。
   */
  function renderRows(sessions: SessionSnapshot[]): string {
    const rows = buildAgentRoster({ sessions, providerCatalog: [] })
    const full = renderToStaticMarkup(
      createElement(
        DropdownMenu.Root,
        { open: true },
        createElement(DropdownMenu.Trigger, null, 'open'),
        createElement(
          DropdownMenu.Content,
          { forceMount: true },
          ...rows.map((row) =>
            createElement(RosterRowView, {
              key: row.sessionId,
              row,
              onSelect: () => {},
              reportError: () => {}
            })
          )
        )
      )
    )
    // 只保留行本身，丢掉 Radix 的外壳。**这一步是必须的，不是整洁癖**：popper 外壳的内联样式里有
    // `transform:translate(0, -200%)`，于是「断言不出现 0%」在整段 markup 上恒假——它匹配到的是
    // 定位脚手架，不是我们渲染的任何数字。实测踩到了这一脚。
    const matches = full.match(/<div role="menuitem"[\s\S]*?<\/div>(?=<div role="menuitem"|<\/div><\/div>$)/g)
    expect(matches, '没抓到任何一行——选择器与 Radix 的结构脱节了，下面的断言会全部恒真').not.toBeNull()
    expect(matches!.length, '抓到的行数与投影出的行数不符').toBe(rows.length)
    return matches!.join('')
  }

  it('快满的行带上百分比与档位，还早的行什么都不带', () => {
    const markup = renderRows([withContext('full', 190_000, 200_000), withContext('quiet', 20_000, 200_000)])

    expect(markup).toContain("data-pressure=\"danger\"")
    expect(markup).toContain('95%')
    // 还早的那行绝不能也挂一枚标记——一屏都是徽章，等于没有徽章。
    expect(markup).not.toContain("data-pressure=\"caution\"")
    expect(markup).not.toContain('10%')
  })

  it('不报用量的行没有压力标记，且不显示 0%', () => {
    // 0% 会被读成「刚开始跑」。这条挡的是「用 ?? 0 兜底」那类改动一路漏到 DOM。
    const markup = renderRows([agent('no-usage')])

    expect(markup).not.toContain('data-pressure')
    expect(markup).not.toContain('0%')
  })

  it('标记说的是该做什么，不是颜色名——且这句话进得了可访问名', () => {
    const markup = renderRows([withContext('warm', 150_000, 200_000)])

    // title 给鼠标，aria-label 给屏幕阅读器；两处都得有，且说的是下一步而不是形容词。
    expect(markup).toContain('75% full')
    expect(markup).toContain('start a fresh session')
    // 颜色名绝不出现在文案里：对听的人「amber」毫无信息，对色盲用户也一样。
    expect(markup.toLowerCase()).not.toContain('amber')
    expect(markup.toLowerCase()).not.toContain('>red<')
  })

  it('够不上门槛的行，可访问名里连提都不提上下文', () => {
    // 给每一行都念一句「上下文正常」，会把真正需要听见的那两行埋掉。缺席即正常。
    const markup = renderRows([withContext('quiet', 20_000, 200_000)])

    expect(markup).not.toContain('context ')
    expect(markup).not.toContain('fresh session')
  })

  // ── CSS 合同：本仓 vitest 跑在 node 环境，没有布局引擎，DOM 测试永远看不见「它是什么颜色」。
  // 而这枚标记的**全部意义**就是颜色差异：两档若解析成同一个颜色，上面四条照样全绿，界面上
  // caution 和 danger 长得一模一样。所以直接读样式表，判两档各自解析到不同的色相 token。
  it('两档在样式表里解析到不同的颜色，不是同一个 token', () => {
    const css = readFileSync(
      new URL('../src/renderer/src/styles/overlays.css', import.meta.url), 'utf8'
    )
    const ruleFor = (tier: string): string => {
      const at = css.indexOf(`.agent-roster__pressure[data-pressure='${tier}']`)
      expect(at, `样式表里没有 ${tier} 这一档的规则`).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    const caution = ruleFor('caution')
    const danger = ruleFor('danger')

    // 自证：两条规则都真的引用了颜色 token，不是空规则（空规则下面那条不等式恒真）。
    expect(caution).toMatch(/var\(--[a-z-]+\)/)
    expect(danger).toMatch(/var\(--[a-z-]+\)/)
    // 关键判据：两档引用的 token 集合必须不同。改成同色（或把 danger 复制成 caution）即红。
    const tokens = (rule: string) => new Set(rule.match(/var\(--[a-z-]+\)/g) ?? [])
    expect([...tokens(caution)].sort()).not.toEqual([...tokens(danger)].sort())
  })
})
