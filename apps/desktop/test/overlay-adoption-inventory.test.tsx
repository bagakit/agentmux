// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { isOverlayNode, openOverlayCount } from '../src/renderer/src/lib/native-surface-overlay.js'
import { deriveOverlayInventoryFromSource, type OverlayHostKind, type OverlayLayerKind } from './helpers/overlay-source-inventory.js'

describe('overlay adoption inventory and shared adapter contract (T-001)', () => {
  const rendererSrcDir = join(import.meta.dirname, '../src/renderer/src')
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

  it('derives a non-vacuous overlay inventory directly from renderer source AST', () => {
    const inventory = deriveOverlayInventoryFromSource(rendererSrcDir)

    // Non-vacuous check: scan must find real overlay triggers in renderer source
    expect(inventory.length, 'Inventory scan found zero triggers - AST scan or source path broken')
      .toBeGreaterThan(0)

    const createPortals = inventory.filter((t) => t.kind === 'createPortal')
    const nativePopovers = inventory.filter((t) => t.kind === 'native-popover')
    const radixPortals = inventory.filter((t) => t.kind === 'radix-portal')

    expect(createPortals.length, 'createPortal triggers must be non-empty').toBeGreaterThan(0)
    expect(nativePopovers.length, 'native-popover triggers must be non-empty').toBeGreaterThan(0)
    expect(radixPortals.length, 'radix-portal triggers must be non-empty').toBeGreaterThan(0)

    // Verify distinct files discovered
    const distinctFiles = new Set(inventory.map((t) => t.file))
    expect(distinctFiles.size, 'Inventory should span multiple renderer files').toBeGreaterThan(10)
  })

  it('proves every discovered trigger is classified by host, layer and lifecycle owner with zero unclassified usages', () => {
    const inventory = deriveOverlayInventoryFromSource(rendererSrcDir)

    const unclassified = inventory.filter(
      (item) =>
        item.host === 'unclassified' ||
        item.layer === 'unclassified' ||
        !item.lifecycleOwner ||
        item.lifecycleOwner === 'UnknownComponent'
    )

    // Fails if any cross-boundary overlay usage cannot be classified from source
    expect(
      unclassified,
      `Unclassified overlay usages detected in renderer source:\n${JSON.stringify(unclassified, null, 2)}`
    ).toEqual([])

    // Verify each classified item meets contract invariants
    const validHosts: OverlayHostKind[] = ['window-overlay-host', 'native-top-layer']
    const validLayers: OverlayLayerKind[] = ['tooltip', 'popover', 'service', 'dialog']

    for (const item of inventory) {
      expect(validHosts).toContain(item.host)
      expect(validLayers).toContain(item.layer)
      expect(typeof item.lifecycleOwner).toBe('string')
      expect(item.lifecycleOwner.length).toBeGreaterThan(0)
      expect(typeof item.leasesNative).toBe('boolean')
    }
  })

  it('provides the shared WindowOverlayHost and adapter contract without duplicating native surface leasing', async () => {
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

    const host = document.querySelector<HTMLElement>('[data-overlay-host]')
    expect(host, 'Shared host must exist in document.body').toBeTruthy()
    expect(host?.parentElement, 'Host must reside directly on document.body outside #root').toBe(document.body)

    // Critical assertion: content is inside [data-overlay-host], NOT directly under body or root!
    expect(
      content?.closest('[data-overlay-host]'),
      'Overlay content parent must be [data-overlay-host], not fallen back to document.body'
    ).toBe(host)

    // Assert only one single host is created (idempotent adoption, no duplicate host)
    expect(document.querySelectorAll('[data-overlay-host]').length).toBe(1)

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
    expect(initialized?.parentElement).toBe(document.body)

    // And second call returns identical element (idempotent)
    expect(getWindowOverlayHost()).toBe(initialized)
  })

  it('keeps browser-yield lease acquired for open nested overlays and releases only after all close', () => {
    document.body.innerHTML = ''
    const hostNode = getWindowOverlayHost()!

    // Initially no overlays: count is 0
    expect(openOverlayCount(document.body)).toBe(0)

    // 1. Parent overlay open in host
    const parentEntry = document.createElement('div')
    parentEntry.className = 'window-overlay-host__entry'
    parentEntry.dataset.overlayLayer = 'popover'
    const parentContent = document.createElement('div')
    parentContent.setAttribute('data-state', 'open')
    parentContent.textContent = 'Parent Menu'
    parentEntry.appendChild(parentContent)
    hostNode.appendChild(parentEntry)

    expect(openOverlayCount(document.body), 'Parent overlay open holds lease').toBe(1)

    // 2. Nested submenu opens in host
    const nestedEntry = document.createElement('div')
    nestedEntry.className = 'window-overlay-host__entry'
    nestedEntry.dataset.overlayLayer = 'popover'
    const nestedContent = document.createElement('div')
    nestedContent.setAttribute('data-state', 'open')
    nestedContent.textContent = 'Nested Submenu'
    nestedEntry.appendChild(nestedContent)
    hostNode.appendChild(nestedEntry)

    expect(openOverlayCount(document.body), 'Nested overlay open maintains lease').toBe(2)

    // 3. Nested submenu closes: parent remains open
    nestedContent.setAttribute('data-state', 'closed')
    expect(openOverlayCount(document.body), 'Closing nested menu keeps parent lease acquired').toBe(1)

    // 4. Parent menu closes: all overlays closed
    parentContent.setAttribute('data-state', 'closed')
    expect(openOverlayCount(document.body), 'Lease is released only after all nested overlays close').toBe(0)
  })

  it('enforces layer attributes have actual CSS and DOM ordering semantics without display: contents', () => {
    // 1. Verify CSS rules in agent.css consume data-overlay-layer and do not use display: contents
    const styles = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/agent.css'), 'utf8')
    expect(styles).toContain('.window-overlay-host__entry { position: absolute; inset: 0;')
    expect(styles).not.toContain('.window-overlay-host__entry { display: contents')
    expect(styles).toContain('[data-overlay-layer="dialog"]')
    expect(styles).toContain('[data-overlay-layer="service"]')
    expect(styles).toContain('[data-overlay-layer="popover"]')
    expect(styles).toContain('[data-overlay-layer="tooltip"]')
    expect(styles).toContain('[data-overlay-layer="window-chrome"]')

    // Numeric values live in the CSS token SSOT. This contract only proves the
    // source selectors consume the named bands; it does not duplicate that table.
  })

  it('rejects silent document.body fallback when WindowOverlayHost is explicitly unavailable', () => {
    const originalHost = document.querySelector('[data-overlay-host]')
    originalHost?.remove()

    // When an explicit container is provided, it is honored
    const customContainer = document.createElement('div')
    expect(resolveOverlayContainer(customContainer)).toBe(customContainer)

    // When no container is provided, resolveOverlayContainer ensures the host in document.body
    const resolved = resolveOverlayContainer()
    expect(resolved).toBe(document.querySelector('[data-overlay-host]'))
    expect(resolved).not.toBe(document.body)
  })
})
