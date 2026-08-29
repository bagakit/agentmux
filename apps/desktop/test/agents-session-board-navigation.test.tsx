// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome.js'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'

describe('Focus / Workspaces / Work navigation', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
  })

  it('renders one three-item switch with Focus, Workspaces, and Work labels', async () => {
    useAppStore.setState({ mainSurface: 'agents' })
    await act(async () => root.render(createElement(SurfaceSwitch)))
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Focus', 'Workspaces', 'Work'])
    expect(buttons.filter((button) => button.classList.contains('selected'))).toHaveLength(1)
    expect(buttons[0]?.classList.contains('selected')).toBe(true)
  })

  it('keeps the Project Rail out of the global Agents surface', async () => {
    // 基址取本文件的位置而不是 `process.cwd()`：cwd 取决于谁在哪一层发起 vitest，从仓根跑
    // （`pnpm test:fast` 就是）解析成 `<repo>/src/…` 直接 ENOENT，从 apps/desktop 跑才对。
    // 同一条判据在两个目录下一红一绿，那不是判据，是掷硬币。
    // 用 `import.meta.dirname` 而非 `new URL(…, import.meta.url)`：happy-dom 环境下
    // `import.meta.url` 是 http scheme，`readFileSync` 会抛 "The URL must be of scheme file"。
    // 本仓其它 happy-dom 测试（session-connecting-surface、message-tools-three-state）也都这么写。
    const source = readFileSync(join(import.meta.dirname, '../src/renderer/src/App.tsx'), 'utf8')
    expect(source).toContain("mainSurface === 'board' || mainSurface === 'agents'")
    expect(source).toContain('!globalSurfaceOwnsProjectRail && projectRailOpen')
  })

  it('does not create a DemandWorkspace when no request is selected', async () => {
    useAppStore.setState({ sessions: [], demands: {}, selectedDemandId: null, mainSurface: 'board' })
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    expect(container.querySelector('.global-board-surface')).toBeTruthy()
    expect(container.querySelector('.global-demand-workspace')).toBeNull()
    expect(container.querySelector('.global-board-toolbar')?.textContent).toContain('Work')
    expect(container.querySelector('.global-board-toolbar')?.textContent).toContain('Requests & ideas')
    expect(container.querySelector('.global-board-toolbar')?.textContent).not.toContain('Focus')
  })
})
