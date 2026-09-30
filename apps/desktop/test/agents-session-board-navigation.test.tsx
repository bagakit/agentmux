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
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
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

  it('renders the work-surface order with one selected surface and no right utility in the left group', async () => {
    useAppStore.setState({ mainSurface: 'survey' })
    await act(async () => root.render(createElement(SurfaceSwitch)))
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(4)
    const mote = document.querySelector('button[aria-controls="pmo-teams-topic-floating-panel"]')
    expect(mote).not.toBeNull(); expect(mote!.getAttribute('aria-label')).toContain('Mote')
    expect(container.contains(mote)).toBe(false)
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Space: show terminal and file workbench',
      expect.stringMatching(/^Focus: show execution contexts\. \d+ working, \d+ requests, \d+ failed$/),
      'Goals: show goals and progress',
      'Survey: browse and manage pages'
    ])
    expect(buttons.filter((button) => button.classList.contains('selected'))).toHaveLength(1)
    expect(buttons[3]?.classList.contains('selected')).toBe(true)
    expect(buttons[3]?.getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('.surface-navigation')).toBeTruthy()
    expect(container.querySelectorAll('.surface-navigation__slot')).toHaveLength(4)
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
    await act(async () => root.render(createElement(SurfaceSwitch)))
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
    await act(async () => root.render(createElement(SurfaceSwitch)))
    const group = container.querySelector('[role="group"][aria-label="Work surfaces"]')
    expect(group).toBeTruthy()
    expect(group!.querySelectorAll('button')).toHaveLength(4)
    const pmo = document.querySelector('button[aria-controls="pmo-teams-topic-floating-panel"]') as HTMLButtonElement
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

  it('opens Settings from the right utilities without changing the selected surface or execution focus', async () => {
    const openSettings = vi.fn(), closeSettings = vi.fn()
    useAppStore.setState({ mainSurface: 'board' })
    const focus = useAppStore.getState().agentFocus
    const utility = (settingsOpen: boolean) => createElement(SettingsNavigation.Provider, { value: { open: openSettings } },
      createElement(WindowUtilityBar, { settingsOpen, onCloseSettings: closeSettings }))
    await act(async () => root.render(utility(false)))
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Keyboard shortcuts', 'Settings'])
    const settings = buttons[1]!
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    expect(settings.hasAttribute('aria-current')).toBe(false)
    await act(async () => settings.click())
    expect(openSettings).toHaveBeenCalledExactlyOnceWith('overview')
    await act(async () => buttons[0]!.click())
    expect(openSettings).toHaveBeenLastCalledWith('keyboard-shortcuts')
    await act(async () => root.render(utility(true)))
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    await act(async () => settings.click())
    expect(closeSettings).toHaveBeenCalledOnce()
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().agentFocus).toEqual(focus)
  })

  it('clamps the rendered tooltip at both window edges', async () => {
    let anchorLeft = 4
    const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(300)
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { left: anchorLeft, top: 760, width: this.classList.contains('surface-navigation__tooltip') ? 180 : 36 } as DOMRect
    })
    try {
      await act(async () => root.render(createElement(SurfaceSwitch)))
      const launcher = container.querySelector('button[aria-label^="Survey"]')!
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
    expect(container.querySelector('.goals-detail')).toBeNull()
    expect(container.querySelector('.goals-list')).toBeNull()
    expect(container.querySelector('.goals-empty')?.textContent).toBe('目标会显示在这里。')
    expect(container.querySelector('.goals-toolbar')?.textContent).toContain('New Goal')
    expect(container.querySelector('input[aria-label="Search goals"]')).toBeTruthy()
    expect(container.querySelector('.goals-footer')?.textContent).toContain('0 of 0 goals')
    expect(container.querySelector('.goals-toolbar')?.textContent).not.toContain('Focus')
  })
})
