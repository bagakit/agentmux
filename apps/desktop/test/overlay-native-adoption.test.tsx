// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { AgentAvatar, ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar'
import { TopicWorkbenchTopology } from '../src/renderer/src/components/TopicPresence'
import { getWindowOverlayHost } from '../src/renderer/src/components/WindowOverlayHost'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import { OpenDestinationPopover } from '../src/renderer/src/components/OpenDestinationBar'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentContextUsage } from '../src/renderer/src/components/AgentContextUsage'
import { useAppStore } from '../src/renderer/src/store'
import { deriveOverlayInventoryFromSource } from './helpers/overlay-source-inventory.js'

const AVATAR_CSS = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/agent-avatar.css'), 'utf8')
const TOPOLOGY_CSS = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/topic-topology.css'), 'utf8')
const OVERLAYS_CSS = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/overlays.css'), 'utf8')
const NOTICES_TSX = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/GlobalSystemNotices.tsx'), 'utf8')
const CONTEXT_TSX = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/AgentContextUsage.tsx'), 'utf8')
const MAILBOX_TSX = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/SessionMailbox.tsx'), 'utf8')
const OPEN_DEST_TSX = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/OpenDestinationBar.tsx'), 'utf8')
const TOP_ROW_TSX = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/TopRowChrome.tsx'), 'utf8')

describe('T-003: Native popover and bespoke portal families adoption', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let host: HTMLDivElement | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    for (const el of document.querySelectorAll('[data-overlay-host]')) el.remove()
    container = document.createElement('div')
    host = getWindowOverlayHost() as HTMLDivElement
    document.body.append(container)
    root = createRoot(container)
    useAppStore.setState({ nativeSurfaceOverlayCount: 0 })
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    host?.remove()
    for (const el of document.querySelectorAll('[data-overlay-host]')) el.remove()
    root = null
    container = null
    host = null
    useAppStore.setState({ nativeSurfaceOverlayCount: 0 })
  })

  it('AgentAvatar portals into the shared overlay host and uses CSS layer tokens', async () => {
    expect(AVATAR_CSS).toContain('z-index: var(--layer-popover);')
    expect(AVATAR_CSS).not.toContain('.agent-identity-popover { position: fixed; z-index: 10000;')
    expect(AVATAR_CSS).toContain('pointer-events: auto;')

    let leaseCalledWith: boolean | null = null
    const onPanelVisibilityChange = (visible: boolean) => {
      leaseCalledWith = visible
    }

    await act(async () => {
      root?.render(
        <ExecutorIdentityContext.Provider value={{ config: null, onPanelVisibilityChange }}>
          <AgentAvatar label="Builder Agent" providerId="claude" state="running" detail="Compiling" />
        </ExecutorIdentityContext.Provider>
      )
    })

    const trigger = container?.querySelector<HTMLElement>('.agent-avatar')
    expect(trigger).toBeTruthy()

    await act(async () => {
      trigger?.focus()
    })

    const panelInHost = host?.querySelector<HTMLDivElement>('.agent-identity-popover')
    const panelInContainer = container?.querySelector<HTMLDivElement>('.agent-identity-popover')
    expect(panelInHost).toBeTruthy()
    expect(panelInContainer).toBeNull()
    expect(panelInHost?.textContent).toContain('Builder Agent')
    expect(panelInHost?.textContent).toContain('Compiling')

    // Escape dismisses the panel and cleans up
    await act(async () => {
      panelInHost?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host?.querySelector('.agent-identity-popover')).toBeNull()
  })

  it('AgentAvatar preserves Browser/native surface lease acquisition and teardown cleanup', async () => {
    const browserStage = document.createElement('div')
    browserStage.dataset.nativeBrowserStage = ''
    browserStage.style.visibility = 'visible'
    browserStage.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800,
      toJSON: () => ({})
    })
    document.body.append(browserStage)

    const onPanelVisibilityChange = (visible: boolean) => {
      if (visible) useAppStore.getState().acquireNativeSurfaceOverlay()
      else useAppStore.getState().releaseNativeSurfaceOverlay()
    }

    await act(async () => {
      root?.render(
        <ExecutorIdentityContext.Provider value={{ config: null, onPanelVisibilityChange }}>
          <AgentAvatar label="Overlapping Agent" providerId="codex" state="running" />
        </ExecutorIdentityContext.Provider>
      )
    })

    const trigger = container?.querySelector<HTMLElement>('.agent-avatar')
    expect(trigger).toBeTruthy()

    await act(async () => {
      trigger?.focus()
    })

    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)

    // Escape dismisses and releases lease
    await act(async () => {
      const panel = host?.querySelector<HTMLDivElement>('.agent-identity-popover')
      panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)

    browserStage.remove()
  })

  it('TopicWorkbenchTopology portals into shared host and uses CSS layer tokens', async () => {
    expect(TOPOLOGY_CSS).toContain('z-index: var(--layer-tooltip);')
    expect(TOPOLOGY_CSS).not.toContain('.topic-workbench-topology__inspector--portal {\n  position: fixed;\n  z-index: 10000;')

    const tabs = [
      {
        tabId: 'tab-1',
        title: 'Core Work',
        active: true,
        regions: [{
          regionId: 'r-1',
          executorLabel: 'codex',
          activity: 'Active',
          surfaceKind: 'agent' as const,
          bounds: { x: 0, y: 0, width: 1, height: 1 }
        }]
      }
    ]

    await act(async () => {
      root?.render(<TopicWorkbenchTopology tabs={tabs} />)
    })

    const topology = container?.querySelector<HTMLElement>('.topic-workbench-topology')
    expect(topology).toBeTruthy()

    // Focus triggers inspector in portal
    await act(async () => {
      topology?.focus()
    })

    const inspectorInHost = host?.querySelector('.topic-workbench-topology__inspector--portal')
    expect(inspectorInHost).toBeTruthy()

    // Blur dismisses inspector
    await act(async () => {
      topology?.blur()
    })
    expect(host?.querySelector('.topic-workbench-topology__inspector--portal')).toBeNull()
  })

  it('TopicWorkbenchTopology absent-host state renders null/closed with zero inline fallback', async () => {
    // Contract: TopicPresence source does not contain an inline inspector fallback
    const TOPOLOGY_TSX = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/TopicPresence.tsx'), 'utf8')
    expect(TOPOLOGY_TSX).not.toMatch(/createPortal\([^)]+\)\s*:\s*inspector/)

    // When overlay host is absent
    host?.remove()
    host = null

    const tabs = [
      {
        tabId: 'tab-1',
        title: 'Core Work',
        active: true,
        regions: [{
          regionId: 'r-1',
          executorLabel: 'codex',
          activity: 'Active',
          surfaceKind: 'agent' as const,
          bounds: { x: 0, y: 0, width: 1, height: 1 }
        }]
      }
    ]

    await act(async () => {
      root?.render(<TopicWorkbenchTopology tabs={tabs} />)
    })

    const topology = container?.querySelector<HTMLElement>('.topic-workbench-topology')
    expect(topology).toBeTruthy()

    // Closed / unhovered: no inline inspector in container
    expect(container?.querySelector('.topic-workbench-topology__inspector')).toBeNull()

    // Even when focused without host: never renders inline fallback
    await act(async () => {
      topology?.focus()
    })
    expect(container?.querySelector('.topic-workbench-topology__inspector')).toBeNull()
  })

  it('Dock tooltip closes on Escape, window blur, and unmount; avoids inline fallback', async () => {
    // Contract: TopRowChrome avoids inline tooltip fallback when host is absent
    expect(TOP_ROW_TSX).not.toContain('renderTooltip(plugin, true)')
    expect(TOP_ROW_TSX).toContain('window.addEventListener(\'keydown\', onKeyDown)')
    expect(TOP_ROW_TSX).toContain('window.addEventListener(\'blur\', onBlur)')

    useAppStore.setState({ mainSurface: 'survey' })
    await act(async () => {
      root?.render(createElement(SurfaceSwitch))
    })

    const searchBtn = container?.querySelector('button[aria-label^="Survey"]') as HTMLButtonElement
    expect(searchBtn).toBeTruthy()

    // Mouse over triggers tooltip in host
    await act(async () => {
      searchBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(host?.querySelector('.surface-navigation__tooltip')).toBeTruthy()

    // Escape closes Dock tooltip
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host?.querySelector('.surface-navigation__tooltip')).toBeNull()

    // Reopen and test window blur
    await act(async () => {
      searchBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(host?.querySelector('.surface-navigation__tooltip')).toBeTruthy()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(host?.querySelector('.surface-navigation__tooltip')).toBeNull()

    // When host is absent: no inline fallback in container
    host?.remove()
    host = null

    await act(async () => {
      searchBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(container?.querySelector('.surface-navigation__tooltip')).toBeNull()
  })

  it('OpenDestinationPopover mounts into shared host, holds browser-yield lease, and dismisses on Escape/outside-click', async () => {
    expect(OVERLAYS_CSS).toContain('.open-destination-bar {')
    expect(OVERLAYS_CSS).toContain('z-index: var(--layer-popover);')
    expect(OVERLAYS_CSS).not.toContain('.open-destination-bar {\n  z-index: 40;')
    expect(OPEN_DEST_TSX).toContain('createPortal')
    expect(OPEN_DEST_TSX).toContain('getWindowOverlayHost')

    let dismissedId: number | null = null
    const request = { id: 42, url: 'https://example.com/doc', x: 200, y: 150 }

    await act(async () => {
      root?.render(
        <OpenDestinationPopover
          request={request}
          canSplit={true}
          onSelect={vi.fn()}
          onDismiss={(id) => { dismissedId = id }}
        />
      )
    })

    // Mounts into host, not container
    const popoverInHost = host?.querySelector('.open-destination-bar')
    expect(popoverInHost).toBeTruthy()
    expect(container?.querySelector('.open-destination-bar')).toBeNull()

    // Browser-yield lease acquired
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)

    // Escape dismisses
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(dismissedId).toBe(42)

    // Unmount releases lease
    await act(async () => {
      root?.render(
        <OpenDestinationPopover
          request={null}
          canSplit={true}
          onSelect={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)
    expect(host?.querySelector('.open-destination-bar')).toBeNull()
  })

  it('proves native popovers yield browser surface and track open/close lifecycle', async () => {
    // 1. GlobalSystemNotices
    expect(NOTICES_TSX).toContain('acquireNativeSurfaceOverlay')
    expect(NOTICES_TSX).toContain('releaseNativeSurfaceOverlay')
    expect(NOTICES_TSX).toContain('popover="auto"')

    await act(async () => {
      root?.render(<GlobalSystemNotices />)
    })

    const noticesDetails = container?.querySelector('.global-system-notices__details') as HTMLElement
    expect(noticesDetails).toBeTruthy()
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)

    // Open native popover
    await act(async () => {
      noticesDetails.dispatchEvent(new Event('toggle', { bubbles: false }))
      // Simulate popover toggle open
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'open' })
      noticesDetails.dispatchEvent(toggleEv)
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)

    // Close native popover
    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'closed' })
      noticesDetails.dispatchEvent(toggleEv)
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)

    // 2. SessionMailbox
    expect(MAILBOX_TSX).toContain('acquireNativeSurfaceOverlay')
    expect(MAILBOX_TSX).toContain('releaseNativeSurfaceOverlay')

    const fakeSystem = { notices: [], unread: [], acknowledge: vi.fn(), available: true } as any
    await act(async () => {
      root?.render(
        <SessionMailbox
          system={fakeSystem}
          timeline={undefined}
          queued={[]}
        />
      )
    })

    const mailboxEl = container?.querySelector('.composer-mailbox') as HTMLElement
    expect(mailboxEl).toBeTruthy()

    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'open' })
      mailboxEl.dispatchEvent(toggleEv)
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)

    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'closed' })
      mailboxEl.dispatchEvent(toggleEv)
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)

    // 3. AgentContextUsage
    expect(CONTEXT_TSX).toContain('acquireNativeSurfaceOverlay')
    expect(CONTEXT_TSX).toContain('releaseNativeSurfaceOverlay')

    await act(async () => {
      root?.render(<AgentContextUsage />)
    })

    const contextCard = container?.querySelector('.composer__context-card') as HTMLElement
    expect(contextCard).toBeTruthy()

    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'open' })
      contextCard.dispatchEvent(toggleEv)
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)

    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'closed' })
      contextCard.dispatchEvent(toggleEv)
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)
  })

  it('enforces no-fallback rule: never mounts to an unnamed host directly on document.body', async () => {
    await act(async () => {
      root?.render(
        <ExecutorIdentityContext.Provider value={{ config: null }}>
          <AgentAvatar label="No Fallback Agent" providerId="claude" state="running" />
        </ExecutorIdentityContext.Provider>
      )
    })

    const trigger = container?.querySelector<HTMLElement>('.agent-avatar')
    expect(trigger).toBeTruthy()

    await act(async () => {
      trigger?.focus()
    })

    // Content is mounted in the named window overlay host
    const hostEl = document.querySelector('[data-overlay-host]')
    expect(hostEl?.querySelector('.agent-identity-popover')).toBeTruthy()

    // No unnamed portal host directly on document.body
    const unnamedHosts = [...document.body.children].filter(
      (el) => el !== container && el !== hostEl && !el.hasAttribute('data-overlay-host')
    )
    expect(unnamedHosts).toHaveLength(0)
  })

  it('source-derived AST scan proves all native and bespoke overlay families adopt window host or explicit top layer', () => {
    const rendererSrcDir = join(import.meta.dirname, '../src/renderer/src')
    const inventory = deriveOverlayInventoryFromSource(rendererSrcDir)

    // Non-vacuous assertion: scan must find active triggers in renderer source
    expect(inventory.length).toBeGreaterThan(0)

    const nativeAndBespoke = inventory.filter(
      (item) =>
        item.kind === 'native-popover' ||
        (item.kind === 'createPortal' && !item.file.includes('Radix')) ||
        item.file.includes('TopRowChrome')
    )
    expect(nativeAndBespoke.length).toBeGreaterThan(0)

    // Verify discovered components cover all native and bespoke families
    const owners = new Set(nativeAndBespoke.map((item) => item.lifecycleOwner))
    expect(owners).toContain('AgentAvatar')
    expect(owners).toContain('TopicWorkbenchTopology')
    expect(owners).toContain('OpenDestinationPopover')
    expect(owners).toContain('GlobalSystemNotices')
    expect(owners).toContain('SessionMailbox')
    expect(owners).toContain('AgentContextUsage')
    expect(TOP_ROW_TSX).toContain('WindowOverlayPortal')

    // Every createPortal must target window-overlay-host, never document-body or unclassified
    const createPortals = nativeAndBespoke.filter((item) => item.kind === 'createPortal')
    expect(createPortals.length).toBeGreaterThan(0)
    for (const cp of createPortals) {
      expect(cp.host, `${cp.file}:${cp.line} must target window-overlay-host`).toBe('window-overlay-host')
      expect(['tooltip', 'popover', 'dialog']).toContain(cp.layer)
    }

    // Every native popover must be classified as native-top-layer
    const nativePopovers = nativeAndBespoke.filter((item) => item.kind === 'native-popover')
    expect(nativePopovers.length).toBeGreaterThan(0)
    for (const np of nativePopovers) {
      expect(np.host, `${np.file}:${np.line} must use native-top-layer`).toBe('native-top-layer')
      expect(['popover', 'service']).toContain(np.layer)
    }

    // Zero unclassified items
    const unclassified = nativeAndBespoke.filter((item) => item.host === 'unclassified' || item.layer === 'unclassified')
    expect(unclassified).toHaveLength(0)
  })

  it('derives retained layout hosts without allowing any body-backed or otherwise unknown attachment', () => {
    const sources = ['AgentRegionHeader.tsx', 'StableWorkbenchView.tsx'].map(file => ({
      file, source: readFileSync(join(import.meta.dirname, '../src/renderer/src/components', file), 'utf8')
    }))
    const fixture = mkdtempSync(join(tmpdir(), 'agentmux-overlay-host-source-'))
    try {
      for (const { file, source } of sources) {
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        const calls: ts.CallExpression[] = []
        function visit(node: ts.Node): void {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createPortal') calls.push(node)
          ts.forEachChild(node, visit)
        }
        visit(ast)
        expect(calls.length).toBe(1)
        writeFileSync(join(fixture, file), source)
      }
      const inventory = deriveOverlayInventoryFromSource(fixture)
      expect(inventory.length).toBeGreaterThan(0)
      expect(inventory.map(item => ({ kind: item.kind, host: item.host }))).toEqual([
        { kind: 'radix-portal', host: 'window-overlay-host' }
      ])
      for (const { file, source } of sources) {
        const attachments: [string, string][] = [
          ['destination.append(host)', 'document.body.append(host)'],
          ["document.createElement('div')", 'document.body'],
          ['destination.append(host)', '{ destination.append(host); document.body.append(host) }']
        ]
        if (source.includes('target ?? home.current')) attachments.push(
          ['const destination = target ?? home.current', 'const destination = document.body'],
          ['document.getElementById(targetId)', 'document.body'])
        if (source.includes('parking.current.append(host)')) attachments.push(
          ['parking.current.append(host)', 'document.body.append(host)'],
          ['document.getElementById(destinationId)', 'document.body'])
        expect(attachments.length).toBe(5)
        for (const [before, after] of attachments) {
          expect(source.split(before).length - 1).toBe(1)
          writeFileSync(join(fixture, file), source.replace(before, after))
          const unknown = deriveOverlayInventoryFromSource(fixture).filter(item => item.kind === 'createPortal')
          expect(unknown.map(item => ({ file: item.file, host: item.host, layer: item.layer }))).toEqual([
            { file, host: 'unclassified', layer: 'unclassified' }
          ])
        }
        writeFileSync(join(fixture, file), source)
      }
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })

  it('neighboring Browser surface probe proves native views yield when overlays open and return on dismiss', async () => {
    useAppStore.setState({ nativeSurfaceOverlayCount: 0 })
    const browserStage = document.createElement('div')
    browserStage.dataset.nativeBrowserStage = ''
    browserStage.style.visibility = 'visible'
    document.body.append(browserStage)

    // Initially: native view has 0 overlay leases
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)

    // 1. OpenDestinationPopover opens over workspace containing browser
    await act(async () => {
      root?.render(
        <OpenDestinationPopover
          request={{ id: 99, url: 'https://example.com/item', x: 100, y: 100 }}
          canSplit={false}
          onSelect={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)

    // Dismiss OpenDestinationPopover: lease releases
    await act(async () => {
      root?.render(
        <OpenDestinationPopover
          request={null}
          canSplit={false}
          onSelect={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    })
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)

    browserStage.remove()
  })
})
