import type { SplitDirection } from '@agentmux/layout'
import type { WorkbenchWindowDocument } from './workbench-windows.js'

export const BROWSER_PAGE_MENU_CHANNEL = 'agentmux:browser-page-menu'

export type BrowserPageMenuItem =
  | { kind: 'separator' }
  | { kind: 'action'; id: number; label: string; enabled: boolean }
  | { kind: 'split'; enabled: boolean; directions: Record<SplitDirection, number> }
  | { kind: 'submenu'; label: string; note?: string; items: BrowserPageMenuItem[] }

export type BrowserPageMenuEvent =
  | { kind: 'opened'; id: string; document: WorkbenchWindowDocument; x: number; y: number; items: BrowserPageMenuItem[] }
  | { kind: 'closed'; id: string }

export type BrowserPageMenuChoice =
  | { kind: 'select'; itemId: number }
  | { kind: 'dismiss'; restorePageFocus: boolean }
