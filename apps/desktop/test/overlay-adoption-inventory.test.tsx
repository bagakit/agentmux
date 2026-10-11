// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWindowOverlayHost,
  OVERLAY_LAYER_BANDS,
  resolveOverlayContainer,
  useWindowOverlayHost,
  WindowOverlayHost,
  WindowOverlayPortal
} from '../src/renderer/src/components/WindowOverlayHost.js'
import * as HoverMenu from '../src/renderer/src/components/HoverDropdownMenu.js'

describe('window overlay host runtime contract', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let hostEl: HTMLElement | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    hostEl = getWindowOverlayHost()
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    hostEl?.remove()
    root = null
    container = null
    hostEl = null
  })

  it('provides the shared WindowOverlayHost, layer attributes and portal destination', async () => {
    // 1. Layer bands enum
    expect(OVERLAY_LAYER_BANDS.windowChrome).toBe('window-chrome')
    expect(OVERLAY_LAYER_BANDS.tooltip).toBe('tooltip')
    expect(OVERLAY_LAYER_BANDS.popover).toBe('popover')
    expect(OVERLAY_LAYER_BANDS.service).toBe('service')
    expect(OVERLAY_LAYER_BANDS.dialog).toBe('dialog')

    // 2. getWindowOverlayHost finds the element
    const host = getWindowOverlayHost()
    expect(host).toBe(hostEl)

    // 3. resolveOverlayContainer provides container resolution to window host
    expect(resolveOverlayContainer(hostEl)).toBe(hostEl)
    expect(resolveOverlayContainer()).toBe(hostEl)

    // 4. WindowOverlayPortal mounts content into the window host with layer attribute
    function ConsumerComponent() {
      const activeHost = useWindowOverlayHost()
      return (
        <div data-testid="consumer">
          <span data-host-ready={activeHost ? 'true' : 'false'} />
          <WindowOverlayPortal layer={OVERLAY_LAYER_BANDS.popover}>
            <div data-testid="portaled-content">Mounted in shared host</div>
          </WindowOverlayPortal>
        </div>
      )
    }

    await act(async () => {
      root?.render(createElement(ConsumerComponent))
    })

    const portaled = hostEl?.querySelector('[data-testid="portaled-content"]')
    expect(portaled).toBeTruthy()
    expect(portaled?.textContent).toBe('Mounted in shared host')

    const portalEntry = hostEl?.querySelector('.window-overlay-host__entry')
    expect(portalEntry?.getAttribute('data-overlay-layer')).toBe('popover')

    // 5. Host element renders with data-overlay-host directly into document.body outside #root
    const hostDiv = document.createElement('div')
    const hostRoot = createRoot(hostDiv)
    await act(async () => {
      hostRoot.render(createElement(WindowOverlayHost))
    })
    expect(document.body.querySelector('.window-overlay-host')).toBeTruthy()
    expect(document.body.querySelector('[data-overlay-host]')).toBeTruthy()
    await act(async () => {
      hostRoot.unmount()
    })
  })

  it('ensures host exists synchronously before any overlay Portal resolves in the initial commit', async () => {
    // Clean document body to verify cold-start bootstrap timing
    document.body.innerHTML = ''
    expect(document.querySelector('[data-overlay-host]')).toBeNull()

    // Sibling layout where overlay child precedes WindowOverlayHost in the initial commit (like App.tsx)
    function AppFixture() {
      return (
        <div id="root">
          <HoverMenu.Root open>
            <HoverMenu.Trigger>Open</HoverMenu.Trigger>
            <HoverMenu.Portal>
              <HoverMenu.Content data-testid="initial-commit-content">
                <HoverMenu.Item>Item 1</HoverMenu.Item>
              </HoverMenu.Content>
            </HoverMenu.Portal>
          </HoverMenu.Root>
          <WindowOverlayHost />
        </div>
      )
    }

    const appRoot = document.createElement('div')
    document.body.appendChild(appRoot)
    const testRoot = createRoot(appRoot)

    await act(async () => {
      testRoot.render(createElement(AppFixture))
    })

    const content = document.body.querySelector('[data-testid="initial-commit-content"]')
    expect(content, 'Overlay content must be rendered in DOM').toBeTruthy()

    const host = getWindowOverlayHost()
    expect(host, 'Shared host must exist in document.body').toBeTruthy()
    expect(host?.parentElement?.parentElement, 'Interaction host belongs to the one window root outside #root').toBe(document.body)

    // Critical assertion: content is inside [data-overlay-host], NOT directly under body or root!
    expect(
      content?.closest('[data-overlay-host]'),
      'Overlay content parent must be [data-overlay-host], not fallen back to document.body'
    ).toBe(host)

    // Assert only one single host is created (idempotent adoption, no duplicate host)
    expect(document.querySelectorAll('#agentmux-window-overlay-host')).toHaveLength(1)
    expect(document.querySelectorAll('#agentmux-window-overlay-host-interaction')).toHaveLength(1)

    await act(async () => {
      testRoot.unmount()
    })
  })

  it('counterexample: without synchronous host initialization, overlay portals fall back to document.body or fail', () => {
    document.body.innerHTML = ''
    // If the host node is removed/missing before query, raw DOM query returns null
    const uninitialized = document.querySelector('[data-overlay-host]')
    expect(uninitialized, 'DOM query on uninitialized body returns null').toBeNull()

    // Proves that getWindowOverlayHost synchronously ensures the host node before any portal evaluates
    const initialized = getWindowOverlayHost()
    expect(initialized, 'Synchronous ensure must provide non-null host').not.toBeNull()
    expect(initialized?.hasAttribute('data-overlay-host')).toBe(true)
    expect(initialized?.parentElement?.parentElement).toBe(document.body)

    // And second call returns identical element (idempotent)
    expect(getWindowOverlayHost()).toBe(initialized)
  })

  it('rejects silent document.body fallback when WindowOverlayHost is explicitly unavailable', () => {
    const originalHost = document.querySelector('[data-overlay-host]')
    originalHost?.remove()

    // When an explicit container is provided, it is honored
    const customContainer = document.createElement('div')
    expect(resolveOverlayContainer(customContainer)).toBe(customContainer)

    // When no container is provided, resolveOverlayContainer ensures the host in document.body
    const resolved = resolveOverlayContainer()
    expect(resolved).toBe(getWindowOverlayHost())
    expect(resolved).not.toBe(document.body)
  })
})
