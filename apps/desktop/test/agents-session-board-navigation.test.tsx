// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome.js'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface.js'
import { WindowUtilityBar } from '../src/renderer/src/components/WindowUtilityBar.js'
import { useAppStore } from '../src/renderer/src/store.js'

describe('PMO / Space / Focus / Goals / Survey navigation', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    localStorage.removeItem('agentmux.leader-topic-floating.v1')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
    localStorage.removeItem('agentmux.leader-topic-floating.v1')
  })

  it('renders the confirmed order with Settings after Survey and names with one selected surface', async () => {
    useAppStore.setState({ mainSurface: 'survey' })
    await act(async () => root.render(createElement(SurfaceSwitch, { onOpenSettings: vi.fn() })))
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(6)
    expect(buttons[0]?.getAttribute('aria-label')).toContain('PMO teams topic')
    expect(buttons.slice(1).map((button) => button.getAttribute('aria-label'))).toEqual([
      'Space: show terminal and file workbench',
      'Focus: show execution contexts',
      'Goals: show goals and progress',
      'Survey: browse and verify information',
      'Settings'
    ])
    expect(buttons.filter((button) => button.classList.contains('selected'))).toHaveLength(1)
    expect(buttons[4]?.classList.contains('selected')).toBe(true)
    expect(buttons[4]?.getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('.surface-navigation')).toBeTruthy()
    expect(container.querySelectorAll('.surface-navigation__slot')).toHaveLength(6)
    // Tooltips render on hover/focus only, not up-front for all slots — peer chose to lazy-render
    // the tooltip pane (one at a time, positioned to the hovered button) rather than mount 5 hidden
    // ones. `aria-label` on each button carries the accessible name already; the tooltip is a
    // visual affordance, not the a11y contract. So initial render has zero tooltip nodes.
    expect(container.querySelectorAll('.surface-navigation__tooltip')).toHaveLength(0)
    expect(container.querySelector('.surface-switch--left')).toBeNull()
    expect(container.querySelector('.surface-switch--right')).toBeNull()
  })

  it('switches each product entry to its existing main surface', async () => {
    useAppStore.setState({ mainSurface: 'survey', sessions: [] })
    await act(async () => root.render(createElement(SurfaceSwitch, { onOpenSettings: vi.fn() })))
    const entries = [
      ['Space:', 'workbench'],
      ['Focus:', 'agents'],
      ['Goals:', 'board'],
      ['Survey:', 'survey']
    ] as const
    for (const [label, surface] of entries) {
      const button = container.querySelector(`button[aria-label^="${label}"]`) as HTMLButtonElement
      expect(button).toBeTruthy()
      await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      expect(useAppStore.getState().mainSurface).toBe(surface)
      expect(button.getAttribute('aria-current')).toBe('page')
    }
  })

  it('keeps PMO outside the four-surface group and preserves execution focus while opening and closing it', async () => {
    useAppStore.setState({ mainSurface: 'board' })
    const focus = useAppStore.getState().agentFocus
    await act(async () => root.render(createElement(SurfaceSwitch, { onOpenSettings: vi.fn() })))
    const group = container.querySelector('[role="group"][aria-label="Work surfaces and settings"]')
    expect(group).toBeTruthy()
    expect(group!.querySelectorAll('button')).toHaveLength(5)
    const pmo = container.querySelector('button[aria-controls="pmo-teams-topic-floating-panel"]') as HTMLButtonElement
    expect(pmo).toBeTruthy()
    expect(group!.contains(pmo)).toBe(false)
    expect(container.querySelector('nav')!.contains(pmo)).toBe(false)
    for (const expanded of ['true', 'false']) {
      await act(async () => pmo.click())
      expect(pmo.getAttribute('aria-expanded')).toBe(expanded)
      expect(useAppStore.getState().mainSurface).toBe('board')
      expect(useAppStore.getState().agentFocus).toEqual(focus)
      expect(group!.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('Goals: show goals and progress')
    }
  })

  it('opens Settings after Survey without changing the selected surface or execution focus', async () => {
    const openSettings = vi.fn()
    useAppStore.setState({ mainSurface: 'board' })
    const focus = useAppStore.getState().agentFocus
    await act(async () => root.render(createElement(SurfaceSwitch, { onOpenSettings: openSettings })))
    const buttons = [...container.querySelectorAll('nav button')]
    expect(buttons).toHaveLength(5)
    const settings = buttons[4]!
    expect(buttons[3]!.getAttribute('aria-label')).toBe('Survey: browse and verify information')
    expect(settings.getAttribute('aria-label')).toBe('Settings')
    expect(settings.hasAttribute('aria-current')).toBe(false)
    expect(settings.classList.contains('selected')).toBe(false)
    await act(async () => settings.click())
    expect(openSettings).toHaveBeenCalledExactlyOnceWith('workspaces')
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().agentFocus).toEqual(focus)
    await act(async () => root.render(createElement(WindowUtilityBar)))
    expect([...container.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Keyboard shortcuts'])
  })

  it('clamps the rendered tooltip at both window edges', async () => {
    let anchorLeft = 4
    const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(300)
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return { left: anchorLeft, top: 760, width: this.classList.contains('surface-navigation__tooltip') ? 180 : 36 } as DOMRect
    })
    try {
      await act(async () => root.render(createElement(SurfaceSwitch, { onOpenSettings: vi.fn() })))
      const launcher = container.querySelector('.surface-navigation__slot--launcher')!
      for (const [left, expected] of [[4, '8px'], [280, '112px']] as const) {
        anchorLeft = left
        await act(async () => launcher.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
        const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
        expect(tooltip).toBeTruthy()
        expect(tooltip!.style.left).toBe(expected)
        await act(async () => launcher.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
      }
    } finally { geometry.mockRestore(); viewport.mockRestore() }
  })

  it('keeps the Project Rail out of the global Agents surface', async () => {
    // 基址取本文件的位置而不是 `process.cwd()`：cwd 取决于谁在哪一层发起 vitest，从仓根跑
    // （`pnpm test:fast` 就是）解析成 `<repo>/src/…` 直接 ENOENT，从 apps/desktop 跑才对。
    // 同一条判据在两个目录下一红一绿，那不是判据，是掷硬币。
    // 用 `import.meta.dirname` 而非 `new URL(…, import.meta.url)`：happy-dom 环境下
    // `import.meta.url` 是 http scheme，`readFileSync` 会抛 "The URL must be of scheme file"。
    // 本仓其它 happy-dom 测试（session-connecting-surface、message-tools-three-state）也都这么写。
    const source = readFileSync(join(import.meta.dirname, '../src/renderer/src/App.tsx'), 'utf8')
    expect(source).toContain("mainSurface === 'board' || mainSurface === 'agents' || mainSurface === 'survey'")
    expect(source).toContain('!globalSurfaceOwnsProjectRail && projectRailOpen')
  })

  it('shows Goals, creation and search without inventing a selected goal', async () => {
    useAppStore.setState({ sessions: [], demands: {}, selectedDemandId: null, mainSurface: 'board' })
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    expect(container.querySelector('.global-board-surface')).toBeTruthy()
    expect(container.querySelector('.global-demand-workspace')).toBeNull()
    expect(container.querySelector('.global-board-toolbar__scope > strong')?.textContent).toBe('Goals')
    expect(container.querySelector('.global-board-toolbar')?.textContent).toContain('Goals & progress')
    expect(container.querySelector('.global-board-toolbar')?.textContent).toContain('New Goal')
    expect(container.querySelector('input[aria-label="Search goals"]')).toBeTruthy()
    expect(container.querySelector('.global-board-footer')?.textContent).toContain('0 of 0 goals')
    expect(container.querySelector('.global-board-toolbar')?.textContent).not.toContain('Focus')
  })
})
