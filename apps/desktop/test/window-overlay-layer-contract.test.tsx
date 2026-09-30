// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome.js'
import { getWindowOverlayHost } from '../src/renderer/src/components/WindowOverlayHost.js'
import { useAppStore } from '../src/renderer/src/store.js'

const APP = readFileSync(join(import.meta.dirname, '../src/renderer/src/App.tsx'), 'utf8')
const HOST = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/WindowOverlayHost.tsx'), 'utf8')
const TOP_ROW = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/TopRowChrome.tsx'), 'utf8')
const STYLES = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/agent.css'), 'utf8')
const TOKENS = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/tokens.css'), 'utf8')

describe('window overlay host contract', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let host: HTMLElement | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    host = getWindowOverlayHost()
    expect(host).not.toBeNull()
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    host?.remove()
    root = null
    container = null
    host = null
  })

  it('declares a non-empty window host outside the app shell and names layer tokens', () => {
    const hostAnchor = APP.indexOf('<WindowOverlayHost />')
    const shellCloseBeforeHost = APP.lastIndexOf('</div>', hostAnchor)
    expect(hostAnchor).toBeGreaterThan(-1)
    expect(shellCloseBeforeHost).toBeGreaterThan(-1)
    expect(HOST).toContain('data-overlay-host')
    expect(TOP_ROW).toContain('<WindowOverlayPortal')
    expect(HOST).toContain('return createPortal(')
    expect(STYLES).toContain('.window-overlay-host {')
    expect(STYLES).toContain('.window-overlay-host { position: fixed;')
    expect(STYLES).toContain('isolation: isolate')
    expect(STYLES).toContain('z-index: var(--layer-tooltip)')
    expect(TOKENS).toContain('--layer-tooltip:')
    expect(TOKENS).toContain('--layer-popover:')
    expect(TOKENS).toContain('--layer-dialog:')
  })

  it('mounts the active Dock tooltip in the window host instead of the clipped nav tree', async () => {
    useAppStore.setState({ mainSurface: 'survey' })
    await act(async () => root?.render(createElement(SurfaceSwitch)))
    const search = container?.querySelector('button[aria-label^="Survey"]') as HTMLButtonElement
    expect(search).toBeTruthy()
    await act(async () => search.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const tooltip = host?.querySelector('.surface-navigation__tooltip')
    expect(tooltip?.textContent).toContain('Survey')
    expect(container?.querySelector('.surface-navigation__tooltip')).toBeNull()
  })
})
