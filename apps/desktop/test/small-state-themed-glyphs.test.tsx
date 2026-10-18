// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import type { AppConfig } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { ShortcutSettingsPane } from '../src/renderer/src/components/settings/ShortcutSettingsPane'
import { composerDOM } from './helpers/composer-dom-fixture'
import { currentNotificationRows, toggleNotificationCenter, toggleNotificationDetails } from './helpers/notification-center'
const dom = composerDOM(); let cleanup: () => void, styles: HTMLStyleElement
beforeEach(() => { cleanup = mountThemeRuntime(window); styles = document.createElement('style'); styles.textContent = readFileSync('apps/desktop/src/renderer/src/styles/base.css', 'utf8') + readFileSync('apps/desktop/src/renderer/src/styles/settings-prompts.css', 'utf8'); document.head.append(styles); useAppStore.setState({ loading: false, noticeReadReceipts: {} }) })
afterEach(() => { cleanup(); styles.remove() })
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  expect(node, 'Nonempty original authoring field').not.toBeNull()
  await act(async () => { const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) })
}
const saved = { id: 'original', keyword: 'original', label: 'Original', body: 'Original authored bytes.\n  Last line.' }, config = { composerShortcuts: [saved] } as AppConfig
it('the Prompt editor uses separate saved/unsaved/invalid glyphs while retaining status labels, authored data and save payloads', async () => {
  const save = vi.fn(async () => {})
  await dom.render(<ShortcutSettingsPane config={config} active onSave={save}/>)
  const status = dom.container.querySelector<HTMLElement>('[data-prompt-status]')!, icon = status.querySelector('svg')!
  expect(status, 'nonempty actual status consumer').not.toBeNull(); expect(status.textContent).toBe('Saved')
  expect(status.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.prompt-saved')); expect(document.getElementById(semanticIconHref('status.prompt-saved').slice(1))?.querySelector('circle')?.getAttribute('fill')).toBe('currentColor'); expect(icon.getAttribute('width')).toBe('4')
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.prompt-status'; custom.name = 'Prompt statuses'; custom.icons = { 'status.prompt-saved': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] }, 'status.prompt-unsaved': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z', fill: 'currentColor' }] }, 'status.prompt-invalid': { kind: 'glyph', glyph: 'circle-x' } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(status.querySelector('svg')).toBe(icon); expect(document.getElementById(semanticIconHref('status.prompt-saved').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  await fill(dom.container.querySelector<HTMLInputElement>('.prompt-editor__name input')!, 'Changed name')
  expect(status.textContent).toBe('Unsaved'); expect(status.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.prompt-unsaved'))
  const body = dom.container.querySelector<HTMLTextAreaElement>('.prompt-editor__instruction textarea')!
  await fill(body, '')
  expect(status.textContent).toBe('Needs attention'); expect(status.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.prompt-invalid'))
  expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')?.disabled).toBe(true)
  await fill(body, saved.body); await dom.click('[data-settings-save-bar] button')
  expect(save).toHaveBeenCalledWith([{ ...saved, label: 'Changed name' }], [saved]); expect(config.composerShortcuts).toEqual([saved])
})
it('the real notification inbox themes its icon and single unread badge without marking its notice read or changing health facts', async () => {
  const sessions = useAppStore.getState().sessions
  await dom.render(<GlobalSystemNotices nativeOverlayWarning="Original floating overlay unavailable"/>)
  const button = dom.container.querySelector<HTMLButtonElement>('.global-system-notices__trigger')!, icon = button.querySelector<SVGSVGElement>('svg')!
  const badge = button.querySelector<HTMLElement>('.global-system-notices__badge')!
  expect(badge, 'nonempty unread notice consumer').not.toBeNull()
  expect(button.querySelectorAll('.global-system-notices__badge')).toHaveLength(1)
  expect(button.querySelector('.global-system-notices__dot')).toBeNull()
  expect(badge.textContent).toBe('2')
  expect(icon.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.notifications'))
  expect(icon.getAttribute('width')).toBe('14')
  expect(button.getAttribute('data-attention')).toBe('quiet')
  expect(window.getComputedStyle(badge).color).toBe(window.getComputedStyle(document.documentElement).getPropertyValue('--blue'))
  const before = button.getAttribute('aria-label'), receipts = structuredClone(useAppStore.getState().noticeReadReceipts)
  expect(before).toContain('2 unread'); expect(button.getAttribute('aria-expanded')).toBe('false')
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.notification-status'; custom.name = 'Notifications'; custom.icons = { 'object.notifications': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(button.querySelector('svg')).toBe(icon); expect(button.querySelector('.global-system-notices__badge')).toBe(badge); expect(button.getAttribute('aria-label')).toBe(before)
  expect(document.getElementById(semanticIconHref('object.notifications').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  await toggleNotificationCenter(dom.container, 'open')
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  expect(currentNotificationRows(dom.container).map(row => row.getAttribute('data-notice-id')).sort()).toEqual([
    JSON.stringify(['local', 'agent-1', 'activity-observation']), 'floating-chrome'
  ])
  const notice = dom.container.querySelector<HTMLElement>('.notification-item[data-notice-id="floating-chrome"]')!
  expect(notice).not.toBeNull()
  await toggleNotificationDetails(notice)
  expect(notice.textContent).toContain('Original floating overlay unavailable')
  expect(notice.textContent).toContain('Existing Browser pages and Agents remain available')
  expect(notice.getAttribute('data-kind')).toBe('process-degraded')
  expect(useAppStore.getState().sessions).toBe(sessions)
})
