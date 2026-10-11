// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { AgentAvatar, ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar'
import { WorkbenchTopology } from '../src/renderer/src/components/WorkbenchTopology'
import { getWindowOverlayHost } from '../src/renderer/src/components/WindowOverlayHost'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import { OpenDestinationPopover } from '../src/renderer/src/components/OpenDestinationBar'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentContextUsage } from '../src/renderer/src/components/AgentContextUsage'
import { useAppStore } from '../src/renderer/src/store'

describe('native popover and bespoke portal behavior', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let host: HTMLDivElement | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value() {} })
    for (const el of document.querySelectorAll('[data-overlay-host]')) el.remove()
    container = document.createElement('div')
    host = getWindowOverlayHost() as HTMLDivElement
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    host?.remove()
    for (const el of document.querySelectorAll('[data-overlay-host]')) el.remove()
    root = null
    container = null
    host = null
  })

  it('AgentAvatar portals into the shared overlay host and preserves disclosure actions', async () => {

    await act(async () => {
      root?.render(
        <ExecutorIdentityContext.Provider value={{ config: null }}>
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

  it('WorkbenchTopology portals into the shared host and preserves focus disclosure', async () => {

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
      root?.render(<WorkbenchTopology tabs={tabs} />)
    })

    const topology = container?.querySelector<HTMLElement>('.workbench-topology')
    expect(topology).toBeTruthy()

    // Focus triggers inspector in portal
    await act(async () => {
      topology?.focus()
    })

    const inspectorInHost = host?.querySelector('.workbench-topology__inspector--portal')
    expect(inspectorInHost).toBeTruthy()

    // Blur dismisses inspector
    await act(async () => {
      topology?.blur()
    })
    expect(host?.querySelector('.workbench-topology__inspector--portal')).toBeNull()
  })

  it('WorkbenchTopology recreates a missing window host without mounting an inline inspector', async () => {

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
      root?.render(<WorkbenchTopology tabs={tabs} />)
    })

    const topology = container?.querySelector<HTMLElement>('.workbench-topology')
    expect(topology).toBeTruthy()

    // Closed / unhovered: no inline inspector in container
    expect(container?.querySelector('.workbench-topology__inspector')).toBeNull()

    // Focusing recreates its one window host; the inspector never enters the workbench layout
    await act(async () => {
      topology?.focus()
    })
    expect(container?.querySelector('.workbench-topology__inspector')).toBeNull()
    expect(getWindowOverlayHost()?.querySelector('.workbench-topology__inspector--portal')).not.toBeNull()
  })

  it('Dock tooltip closes on Escape, window blur, and unmount; avoids inline fallback', async () => {

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

  it('OpenDestinationPopover mounts into shared scope and dismisses on Escape/outside-click', async () => {

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

    // Escape dismisses
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(dismissedId).toBe(42)

    // Unmount removes the original surface
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
    expect(host?.querySelector('.open-destination-bar')).toBeNull()
  })

  it('tracks the original native popovers through open and close', async () => {
    // The native toggle changes the original accessible disclosure state.

    await act(async () => {
      root?.render(<GlobalSystemNotices />)
    })

    const noticesDetails = container?.querySelector('.global-system-notices__details') as HTMLElement
    expect(noticesDetails).toBeTruthy()

    // Open native popover
    await act(async () => {
      noticesDetails.dispatchEvent(new Event('toggle', { bubbles: false }))
      // Simulate popover toggle open
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'open' })
      noticesDetails.dispatchEvent(toggleEv)
    })
    expect(container?.querySelector(`[aria-controls="${noticesDetails.id}"]`)?.getAttribute('aria-expanded')).toBe('true')

    // Close native popover
    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'closed' })
      noticesDetails.dispatchEvent(toggleEv)
    })
    expect(container?.querySelector(`[aria-controls="${noticesDetails.id}"]`)?.getAttribute('aria-expanded')).toBe('false')

    // 2. SessionMailbox

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
    expect(mailboxEl.dataset.state).toBe('open')
    expect(mailboxEl.inert).toBe(false)

    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'closed' })
      mailboxEl.dispatchEvent(toggleEv)
    })
    expect(mailboxEl.dataset.state).toBe('closed')
    expect(mailboxEl.inert).toBe(true)

    // 3. AgentContextUsage

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
    expect(container?.querySelector(`[aria-controls="${contextCard.id}"]`)?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      const toggleEv = new Event('toggle')
      Object.assign(toggleEv, { newState: 'closed' })
      contextCard.dispatchEvent(toggleEv)
    })
    expect(container?.querySelector(`[aria-controls="${contextCard.id}"]`)?.getAttribute('aria-expanded')).toBe('false')
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

})
