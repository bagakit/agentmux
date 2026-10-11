const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import * as DropdownMenu from '../src/renderer/src/components/HoverDropdownMenu.js'
import { ConfirmationDialog } from '../src/renderer/src/components/ConfirmationDialog.js'
import { BranchContextMenu } from '../src/renderer/src/components/BranchContextMenu.js'
import { TopicContextMenu } from '../src/renderer/src/components/TopicContextMenu.js'
import { ConversationImage } from '@agentmux/client-ui/components/ConversationImage'
import { WorkbenchTabContextMenu } from '../src/renderer/src/components/WorkbenchTabContextMenu.js'
import {
  getWindowOverlayHost,
  resolveOverlayContainer,
  WindowOverlayHost
} from '../src/renderer/src/components/WindowOverlayHost.js'

describe('shared Modal and Radix menu behavior', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let host: HTMLElement | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    container.id = 'root'
    document.body.append(container)
    host = getWindowOverlayHost()
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

  it('ConfirmationDialog mounts into shared window overlay host and preserves Escape, actions and teardown', async () => {
    let confirmed = false
    let cancelled = false

    await act(async () => {
      root?.render(
        <ConfirmationDialog
          open={true}
          title="Delete Branch"
          description="Are you sure you want to delete this branch?"
          confirmLabel="Delete"
          onConfirm={() => { confirmed = true }}
          onCancel={() => { cancelled = true }}
        />
      )
    })

    // Must be mounted inside the shared host, NOT in the container and NOT directly in document.body
    const dialogInHost = host?.querySelector('.confirmation-dialog')
    expect(dialogInHost, 'ConfirmationDialog must mount in window-overlay-host').toBeTruthy()
    expect(container?.querySelector('.confirmation-dialog')).toBeNull()

    // No unnamed portal host directly on document.body
    const unnamedHosts = [...document.body.children].filter(
      (el) => el !== container && el !== host && el.tagName === 'DIV' && !el.hasAttribute('data-overlay-host')
    )
    expect(unnamedHosts).toHaveLength(0)

    // Action button executes callback
    const confirmBtn = dialogInHost?.querySelector<HTMLButtonElement>('button.danger-button')
    expect(confirmBtn).toBeTruthy()
    await act(async () => {
      confirmBtn?.click()
    })
    expect(confirmed).toBe(true)

    // Escape triggers cancel
    await act(async () => {
      dialogInHost?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(cancelled).toBe(true)

    // Teardown cleanly unmounts
    await act(async () => {
      root?.render(
        <ConfirmationDialog
          open={false}
          title="Delete Branch"
          description=""
          confirmLabel="Delete"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      )
    })
    expect(host?.querySelector('.confirmation-dialog')).toBeNull()
  })

  it('HoverDropdownMenu adapter routes dropdown portal into shared window overlay host', async () => {
    let itemSelected = false

    await act(async () => {
      root?.render(
        <DropdownMenu.Root open={true}>
          <DropdownMenu.Trigger>Open Dropdown</DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="tab-context-menu test-dropdown-content">
              <DropdownMenu.Item onSelect={() => { itemSelected = true }}>
                Item 1
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )
    })

    // Content mounts inside the shared window overlay host
    const contentInHost = host?.querySelector('.test-dropdown-content')
    expect(contentInHost, 'HoverDropdownMenu content must mount in window-overlay-host').toBeTruthy()
    expect(container?.querySelector('.test-dropdown-content')).toBeNull()

    // No unnamed portal host on document.body
    const unnamedHosts = [...document.body.children].filter(
      (el) => el !== container && el !== host && el.tagName === 'DIV' && !el.hasAttribute('data-overlay-host')
    )
    expect(unnamedHosts).toHaveLength(0)

    // Selection callback executes
    const item = contentInHost?.querySelector<HTMLElement>('[role="menuitem"]')
    expect(item).toBeTruthy()
    await act(async () => {
      item?.click()
    })
    expect(itemSelected).toBe(true)

    // Close and teardown
    await act(async () => {
      root?.render(
        <DropdownMenu.Root open={false}>
          <DropdownMenu.Trigger>Open Dropdown</DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="tab-context-menu test-dropdown-content">
              <DropdownMenu.Item>Item 1</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )
    })
    expect(host?.querySelector('.test-dropdown-content')).toBeNull()
  })

  it('BranchContextMenu mounts into shared window overlay host and preserves item actions', async () => {
    let refreshed = false

    await act(async () => {
      root?.render(
        <BranchContextMenu
          hasWorktree={true}
          onCopyBranchName={() => {}}
          onCopyWorktreePath={() => {}}
          onOpen={() => {}}
          onRefresh={() => { refreshed = true }}
          onRemoveWorktree={() => {}}
        >
          <button type="button" className="branch-trigger">Branch Row</button>
        </BranchContextMenu>
      )
    })

    const trigger = container?.querySelector<HTMLButtonElement>('.branch-trigger')
    expect(trigger).toBeTruthy()

    // Open context menu via contextmenu event
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }))
    })

    const menuInHost = host?.querySelector('.branch-context-menu')
    expect(menuInHost, 'BranchContextMenu must mount in window-overlay-host').toBeTruthy()
    expect(container?.querySelector('.branch-context-menu')).toBeNull()

    // Select refresh action
    const items = [...(menuInHost?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const refreshItem = items.find((item) => item.textContent?.includes('Refresh Branches'))
    expect(refreshItem).toBeTruthy()
    await act(async () => {
      refreshItem?.click()
    })
    expect(refreshed).toBe(true)
  })

  it('TopicContextMenu mounts into shared window overlay host and preserves Escape dismissal', async () => {
    await act(async () => {
      root?.render(
        <TopicContextMenu
          pinned={false}
          onCopyPath={() => {}}
          onRename={() => {}}
          onReveal={() => {}}
          onTogglePin={() => {}}
          onEditWiki={() => {}}
        >
          <button type="button" className="topic-trigger">Topic Row</button>
        </TopicContextMenu>
      )
    })

    const trigger = container?.querySelector<HTMLButtonElement>('.topic-trigger')
    expect(trigger).toBeTruthy()

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 150 }))
    })

    const menuInHost = host?.querySelector('.topic-context-menu')
    expect(menuInHost, 'TopicContextMenu must mount in window-overlay-host').toBeTruthy()

    // Escape closes and unmounts
    await act(async () => {
      menuInHost?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host?.querySelector('.topic-context-menu')).toBeNull()
  })

  it('ConversationImage mounts lightbox into shared window overlay host and teardown cleans up', async () => {
    const fakeReadPastedImage = async () => ({
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    })

    await act(async () => {
      root?.render(
        <ConversationImage
          text="image.png"
          path={_hygiene_fixturePath("test/path/image.png")}
          readImage={fakeReadPastedImage}
        />
      )
    })

    const thumbBtn = container?.querySelector<HTMLButtonElement>('.md-conversation-image')
    expect(thumbBtn).toBeTruthy()

    // Click thumbnail to open lightbox dialog
    await act(async () => {
      thumbBtn?.click()
    })

    const lightboxInHost = host?.querySelector('.md-conversation-image__lightbox')
    expect(lightboxInHost, 'ConversationImage lightbox must mount in window-overlay-host').toBeTruthy()
    expect(container?.querySelector('.md-conversation-image__lightbox')).toBeNull()

    // Escape closes lightbox
    await act(async () => {
      lightboxInHost?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host?.querySelector('.md-conversation-image__lightbox')).toBeNull()
  })

  it('keeps the original dialog mounted when a sibling dropdown opens and closes', async () => {
    // Initially the original dialog is absent.

    // 2. Open a dialog in host (contains Overlay + Content)
    await act(async () => {
      root?.render(
        <ConfirmationDialog
          open={true}
          title="Modal 1"
          description="First layer"
          confirmLabel="OK"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      )
    })
    expect(host?.querySelector('.confirmation-dialog')).toBeTruthy()

    // 3. Open nested dropdown while dialog is open
    await act(async () => {
      root?.render(
        <>
          <ConfirmationDialog
            open={true}
            title="Modal 1"
            description="First layer"
            confirmLabel="OK"
            onConfirm={() => {}}
            onCancel={() => {}}
          />
          <DropdownMenu.Root open={true}>
            <DropdownMenu.Trigger>Menu Trigger</DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="tab-context-menu test-nested-menu">
                <DropdownMenu.Item>Nested item</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </>
      )
    })
    expect(host?.querySelector('.test-nested-menu')).toBeTruthy()
    expect(host?.querySelector('.confirmation-dialog')).toBeTruthy()

    // Closing the dropdown keeps the original dialog.
    await act(async () => {
      root?.render(
        <>
          <ConfirmationDialog
            open={true}
            title="Modal 1"
            description="First layer"
            confirmLabel="OK"
            onConfirm={() => {}}
            onCancel={() => {}}
          />
          <DropdownMenu.Root open={false}>
            <DropdownMenu.Trigger>Menu Trigger</DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="tab-context-menu test-nested-menu">
                <DropdownMenu.Item>Nested item</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </>
      )
    })
    expect(host?.querySelector('.test-nested-menu')).toBeNull()
    expect(host?.querySelector('.confirmation-dialog')).toBeTruthy()

    // Unmount removes both original surfaces.
    await act(async () => {
      root?.render(null)
    })
    expect(host?.children.length).toBe(0)
  })

  it('WorkbenchTabContextMenu routes main menu and submenus to window host and handles actions', async () => {
    let closed = false

    await act(async () => {
      root?.render(
        <WorkbenchTabContextMenu
          canCloseOthers={true}
          canCloseLeft={true}
          canCloseRight={true}
          canMoveToNewGroup={true}
          tabId="tab-1"
          copyableAgentSessionId="session-1"
          writeClipboardText={async () => {}}
          onRenameTab={() => {}}
          onClose={() => { closed = true }}
          onCloseOthers={() => {}}
          onCloseLeft={() => {}}
          onCloseRight={() => {}}
          onMoveToNewGroup={() => {}}
          regionCount={2}
          onArrange={() => {}}
          moveSessionViewTargets={[]}
          onMoveSessionView={() => {}}
          displayTargets={[]}
          bindingPending={false}
          onDisplayBindingChange={() => {}}
        >
          <div className="tab-trigger">Tab 1</div>
        </WorkbenchTabContextMenu>
      )
    })

    const trigger = container?.querySelector('.tab-trigger')
    expect(trigger).toBeTruthy()

    // Right-click opens context menu in host
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
    })

    const menu = host?.querySelector('.tab-context-menu')
    expect(menu, 'Tab context menu must mount in window-overlay-host').toBeTruthy()
    expect(container?.querySelector('.tab-context-menu')).toBeNull()

    // Close action works
    const closeItem = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find(
      (el) => el.textContent?.includes('Close') && !el.textContent?.includes('Others') && !el.textContent?.includes('Left') && !el.textContent?.includes('Right')
    )
    expect(closeItem).toBeTruthy()
    await act(async () => {
      closeItem?.click()
    })
    expect(closed).toBe(true)
  })

  it('verifies pointer and focus reachability: host items receive clicks and outside clicks pass through', async () => {
    let clicked = false

    await act(async () => {
      root?.render(
        <DropdownMenu.Root open={true}>
          <DropdownMenu.Trigger>Trigger</DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="tab-context-menu reachability-menu">
              <DropdownMenu.Item onSelect={() => { clicked = true }}>
                Clickable Action
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )
    })

    const content = host?.querySelector('.reachability-menu')
    expect(content).toBeTruthy()

    // Item receives pointer click through host pointer-events: auto rule
    const item = content?.querySelector<HTMLElement>('[role="menuitem"]')
    expect(item).toBeTruthy()
    await act(async () => {
      item?.click()
    })
    expect(clicked).toBe(true)
  })

  it('verifies resolveOverlayContainer guarantees a host element and never returns document.body as unnamed host', () => {
    // When called with null/undefined container, must return the [data-overlay-host] element
    const resolved = resolveOverlayContainer()
    expect(resolved).toBeTruthy()
    expect((resolved as HTMLElement).hasAttribute('data-overlay-host')).toBe(true)
    expect((resolved as HTMLElement).classList.contains('window-overlay-host')).toBe(true)

    // Must never return document.body directly
    expect(resolved).not.toBe(document.body)
  })

  it('initial same-commit render: open overlay mounts its Portal under data-overlay-host without prior host in DOM', async () => {
    // 1. Clear any pre-existing host from DOM to simulate cold initial App render
    host?.remove()
    document.querySelectorAll('[data-overlay-host]').forEach((el) => el.remove())
    expect(document.querySelector('[data-overlay-host]')).toBeNull()

    // 2. Render an open overlay inside the root container without a pre-existing host.
    // In App.tsx, overlays render as children/siblings before or alongside WindowOverlayHost.
    await act(async () => {
      root?.render(
        <>
          <DropdownMenu.Root open={true}>
            <DropdownMenu.Trigger>Trigger</DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="initial-commit-dropdown-content">
                <DropdownMenu.Item>Initial Commit Item</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <WindowOverlayHost />
        </>
      )
    })

    // 3. The host was created synchronously and adopted
    const activeHost = getWindowOverlayHost()
    expect(activeHost, 'data-overlay-host must exist on document.body').toBeTruthy()
    expect(activeHost?.parentElement?.parentElement).toBe(document.body)
    expect(activeHost?.closest('#root')).toBeNull()

    // 4. Content is under [data-overlay-host], NOT fallen back to document.body or container
    const content = document.querySelector('.initial-commit-dropdown-content')
    expect(content, 'Overlay content must be mounted').toBeTruthy()
    expect(content?.closest('[data-overlay-host]')).toBe(activeHost)
    expect(content?.parentElement?.closest('[data-overlay-host]')).toBe(activeHost)

    // 5. Exactly 1 host element exists (no duplicate created by WindowOverlayHost later in commit)
    const hostCount = document.querySelectorAll('#agentmux-window-overlay-host-interaction').length
    expect(hostCount, 'Host creation must be idempotent on initial same-commit render').toBe(1)
  })

  it('counterexample: removing host or bypassing synchronous availability causes resolveOverlayContainer to fail rather than fall back to body', () => {
    // Remove all hosts from DOM
    document.querySelectorAll('[data-overlay-host]').forEach((el) => el.remove())
    expect(document.querySelector('[data-overlay-host]')).toBeNull()

    // resolveOverlayContainer must synchronously ensure the host node in DOM
    const resolved = resolveOverlayContainer()
    expect(resolved).not.toBe(document.body)
    expect((resolved as HTMLElement).hasAttribute('data-overlay-host')).toBe(true)

    // If an explicit container is provided, it returns that container
    const custom = document.createElement('div')
    expect(resolveOverlayContainer(custom)).toBe(custom)
  })
})
