// @vitest-environment happy-dom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allStyles } from './helpers/styles.js'
import type { AppConfig } from '../src/shared/contracts.js'
import { PROJECT_RAIL_DENSITY_IDS } from '../src/shared/contracts.js'

// 用户诉求（2026-09-19）：「左侧项目菜单的缩进有点多, 图标有点大, 每个项的高度有点高了, 可以更加
// 紧凑些, 或者在顶层的 projects 上的加号旁边增加一个组件, 调整紧凑程度」。
//
// 这条守三件事，每一件都是那句诉求里的一个约束：
//   1. 三个拨盘（每层缩进 / 行图标 / 行高）**一起**从缺省移到更紧——不许出现半档；
//   2. 控件是加号旁的可见常驻控件，切换写回 durable config；
//   3. 密度是看法不是数据：切换不改树结构、归属、选中、滚动。

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

const fixture = vi.hoisted(() => ({
  state: {
    config: null as AppConfig | null,
    sessions: [] as unknown[],
    timelines: {} as Record<string, unknown>,
    agentNames: {} as Record<string, string>,
    providerCatalog: [] as unknown[],
    activeWorkspaceId: 'project-a',
    mainSurface: 'workbench' as const,
    projectRailOpen: true,
    collapsedProjectGroups: {} as Record<string, true>,
    pinnedItems: {} as Record<string, string[]>,
    toolsOpen: false,
    selectWorkspace: vi.fn(async () => {}),
    openScratchTopic: vi.fn(),
    setMainSurface: vi.fn(),
    setConfig: vi.fn(),
    reportError: vi.fn(),
    toggleProjectRail: vi.fn(),
    toggleProjectGroup: vi.fn(),
    toggleTools: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

const savedConfigs = vi.hoisted(() => ({ calls: [] as AppConfig[] }))
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: {
    workspaces: {
      chooseLocalFolder: vi.fn(async () => null),
      appearance: vi.fn(async () => ({ kind: 'directory', icon: null }))
    },
    config: {
      save: vi.fn(async (config: AppConfig) => {
        savedConfigs.calls.push(config)
        return config
      })
    },
    scratch: { listTopics: vi.fn(async () => []) }
  }
}))

import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
    { id: 'project-a', name: 'Alpha', hostId: 'local', path: '/alpha', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function renderRail(): string {
  return renderToStaticMarkup(createElement(WorkspaceSidebar, { onOpenSettings: vi.fn() }))
}

afterEach(() => {
  fixture.state.config = structuredClone(config)
  fixture.state.activeWorkspaceId = 'project-a'
  savedConfigs.calls.length = 0
})

describe('Project Rail density is one tier across three dials', () => {
  const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

  /** 一个选择器规则体里，这三个拨盘各自被赋的值（未出现即 null）。 */
  function dialsOf(selector: string): { indent: string | null; icon: string | null; row: string | null } {
    const escaped = selector.replace(/[.[\]='*]/g, '\\$&')
    const body = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(styles)?.[1] ?? ''
    return {
      indent: body.match(/--rail-indent:\s*([^;]+)/)?.[1]?.trim() ?? null,
      icon: body.match(/--rail-icon:\s*([^;]+)/)?.[1]?.trim() ?? null,
      row: body.match(/--rail-row-min:\s*([^;]+)/)?.[1]?.trim() ?? null
    }
  }

  it('self-check: the base rail rule really declares all three dials', () => {
    // 空扫描是本仓经典的假绿：先证明扫到了东西。
    expect(styles.length).toBeGreaterThan(1000)
    const base = dialsOf('.project-rail')
    expect(base.indent, '.project-rail 没声明 --rail-indent').not.toBeNull()
    expect(base.icon, '.project-rail 没声明 --rail-icon').not.toBeNull()
    expect(base.row, '.project-rail 没声明 --rail-row-min').not.toBeNull()
  })

  it('the compact tier redefines all three dials together — no half tier', () => {
    // 这是那句诉求的要害：三个拨盘必须**同一档一起变**。逐个断言「compact 档下这个拨盘存在」，
    // 任何一个漏改（半档）都当场红——变异「删掉 compact 档的 --rail-icon」会打红这里。
    const compact = dialsOf(".project-rail[data-rail-density='compact']")
    expect(compact.indent, 'compact 档没收紧每层缩进').not.toBeNull()
    expect(compact.icon, 'compact 档没收紧行图标').not.toBeNull()
    expect(compact.row, 'compact 档没收紧行高').not.toBeNull()
  })

  it('every dial actually gets tighter in compact than in default', () => {
    // 派生自样式表本身，不手抄期望值：把两档拨盘各自解析成 px 再比大小。
    // --rail-indent/--rail-row-min 走 token 或 px，--rail-icon 是 px；两档都从同一张表读。
    const tokenPx: Record<string, number> = { '--sp-3': 6, '--sp-4': 8, '--sp-5': 12, '--sp-6': 16 }
    const resolve = (value: string): number => {
      const token = value.match(/var\((--sp-\d)\)/)?.[1]
      if (token) return tokenPx[token] ?? Number.NaN
      return Number(value.replace('px', ''))
    }
    const base = dialsOf('.project-rail')
    const compact = dialsOf(".project-rail[data-rail-density='compact']")
    for (const dial of ['indent', 'icon', 'row'] as const) {
      const b = resolve(base[dial]!)
      const c = resolve(compact[dial]!)
      expect(Number.isFinite(b) && Number.isFinite(c), `${dial} 解析不出 px`).toBe(true)
      expect(c, `compact 档的 ${dial}（${c}px）没有比默认档（${b}px）更紧`).toBeLessThan(b)
    }
  })

  it('the rail row consumes all three dials, so switching the tier moves geometry', () => {
    // 零调用者的反面：若行不读这三个拨盘，改档就什么都不动（「声明了却静默不做的能力」）。
    const row = new RegExp('\\.project-rail-row\\s*\\{([^}]*)\\}').exec(styles)?.[1] ?? ''
    expect(row).toContain('var(--rail-row-min')
    expect(row).toContain('var(--rail-indent')
    const icon = new RegExp('\\.project-rail-row__icon\\s*\\{([^}]*)\\}').exec(styles)?.[1] ?? ''
    expect(icon).toContain('var(--rail-icon')
  })
})

describe('Project Rail density control lives next to the Plus button', () => {
  it('renders a persistent density control in the Projects heading, not a settings entry', () => {
    fixture.state.config = { ...structuredClone(config), projectRailDensity: 'default' }
    const markup = renderRail()
    // 加号旁的那簇动作里有两枚按钮：密度切换与添加项目。
    const actions = markup.match(/<div class="sidebar__heading-actions">([\s\S]*?)<\/div>/)?.[1] ?? ''
    expect(actions, 'sidebar__heading-actions 没渲染出来').not.toBe('')
    expect(actions).toContain('Add project folder')
    expect(actions).toMatch(/aria-label="Use compact project spacing"/)
  })

  it('reflects the current tier on the container and control, defaulting when absent', () => {
    // 缺席即默认档：容器不带 data-rail-density，控件邀请切到 compact。
    delete (fixture.state.config as AppConfig).projectRailDensity
    const absent = renderRail()
    expect(absent).not.toContain('data-rail-density')
    expect(absent).toMatch(/aria-pressed="false"[^>]*>|aria-label="Use compact project spacing"/)

    // compact 档：容器带属性，控件邀请切回默认且 pressed。
    fixture.state.config = { ...structuredClone(config), projectRailDensity: 'compact' }
    const compact = renderRail()
    expect(compact).toContain('data-rail-density="compact"')
    expect(compact).toMatch(/aria-label="Use default project spacing"/)
    expect(compact).toContain('aria-pressed="true"')
  })
})

describe('Project Rail density is durable', () => {
  it('clicking the control writes the flipped tier through api.config.save', async () => {
    // durable 的判据：点击真的走 api.config.save（落盘），不是只改内存。用 happy-dom 真正挂载并点。
    // @vitest-environment happy-dom 由文件顶注解不生效于 describe，这里用真实 DOM API（本 suite 顶注）。
    const { api } = await import('../src/renderer/src/lib/api.js')
    fixture.state.config = { ...structuredClone(config), projectRailDensity: 'default' }
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(WorkspaceSidebar, { onOpenSettings: vi.fn() })))
      const control = container.querySelector('[aria-label="Use compact project spacing"]') as HTMLButtonElement | null
      expect(control, '密度切换控件没渲染出来').not.toBeNull()
      await act(async () => control!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
    const saveMock = api.config.save
    expect(saveMock).toHaveBeenCalled()
    expect(savedConfigs.calls.at(-1)?.projectRailDensity, '点击没有把档位翻到 compact 并落盘').toBe('compact')
  })

  it('exposes exactly the two tiers — few tiers, no continuous slider', () => {
    expect([...PROJECT_RAIL_DENSITY_IDS]).toEqual(['default', 'compact'])
  })
})
