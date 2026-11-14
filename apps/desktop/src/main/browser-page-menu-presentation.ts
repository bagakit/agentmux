import { mintCapabilityToken } from '@agentmux/core/object-id'
import type { BrowserWindow, WebContents } from 'electron'
import type { WorkbenchWindowDocument } from '../shared/workbench-windows.js'
import type { BrowserPageMenuChoice, BrowserPageMenuEvent, BrowserPageMenuItem } from '../shared/browser-page-menu.js'
import type { BrowserPageMenuTemplate } from './browser-page-context-menu.js'

type ActiveMenu = { id: string; choice(input: BrowserPageMenuChoice): boolean; finish(): void }

/** Window chrome presents an immutable menu. Its actions remain with the original hit owner. */
export class BrowserPageMenuPresentation {
  private active: ActiveMenu | undefined

  constructor(private readonly documentFor: (window: BrowserWindow) => WorkbenchWindowDocument | null,
    private readonly publish: (event: BrowserPageMenuEvent) => void) {}

  show(window: BrowserWindow, contents: WebContents, at: { x: number; y: number }, template: BrowserPageMenuTemplate[],
    isCurrent: () => boolean, finish: () => void): (() => void) | undefined {
    const document = this.documentFor(window)
    if (!document) return undefined
    const id = mintCapabilityToken()
    const actions: Array<{ enabled: boolean; choose: (() => boolean | void) | undefined }> = []
    const items = (rows: BrowserPageMenuTemplate[]): BrowserPageMenuItem[] => rows.flatMap((row): BrowserPageMenuItem[] => {
      if (row.type === 'separator') return [{ kind: 'separator' }]
      if (!row.label) return []
      if (row.submenu) return [{ kind: 'submenu', label: row.label, items: items(row.submenu) }]
      const enabled = row.enabled !== false
      const bind = (choose?: () => boolean | void) => actions.push({ enabled, choose }) - 1
      const split = row.chooseSplit
      if (split) return [{ kind: 'split', enabled, directions: {
        left: bind(() => split('left')), right: bind(() => split('right')),
        up: bind(() => split('up')), down: bind(() => split('down'))
      } }]
      return [{ kind: 'action', id: bind(row.click), label: row.label, enabled }]
    })
    const projected = items(template)
    const valid = () => {
      const observed = this.documentFor(window)
      return this.active?.id === id && !window.isDestroyed() && window.isFocused() &&
        observed?.windowId === document.windowId && observed.documentGeneration === document.documentGeneration
    }
    this.active?.finish()
    this.active = {
      id, finish,
      choice: input => {
        if (input.kind === 'dismiss') {
          const restore = input.restorePageFocus === true && valid() && isCurrent()
          finish()
          if (restore && !contents.isDestroyed()) contents.focus()
          return true
        }
        const item = input.kind === 'select' && Number.isSafeInteger(input.itemId) ? actions[input.itemId] : undefined
        return valid() && !!item?.enabled && !!item.choose && item.choose() !== false
      }
    }
    // Keyboard menu interaction belongs to chrome in this same native window.
    try {
      window.webContents.focus()
      this.publish({ kind: 'opened', id, document, ...at, items: projected })
    } catch (error) {
      if (this.active?.id === id) this.active = undefined
      throw error
    }
    return () => {
      if (this.active?.id !== id) return
      this.active = undefined
      this.publish({ kind: 'closed', id })
    }
  }

  choose(id: string, input: BrowserPageMenuChoice): boolean {
    if (!input || typeof input !== 'object' || this.active?.id !== id) return false
    return this.active.choice(input)
  }
}
