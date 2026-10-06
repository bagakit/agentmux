import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref, type SemanticIconId } from '@agentmux/client-ui/icons'
import { MobileTerminalViewer } from '../src/terminal/MobileTerminalViewer'
import type { MobileTerminalReading } from '../src/terminal/reader'
import { createBrowserPlatform } from '../src/platform/browser'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const canvases = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; textarea: HTMLTextAreaElement }>)
const reports = vi.hoisted(() => [] as Array<(reading: MobileTerminalReading) => void>)
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: Record<string, unknown>
  unicode = { activeVersion: '6' }
  textarea = document.createElement('textarea')
  rows = 24
  buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } }
  element: HTMLElement | undefined
  parser = { registerOscHandler: () => ({ dispose() {} }) }
  constructor(options: Record<string, unknown>) { this.options = options; canvases.push(this) }
  loadAddon() {}
  open(container: HTMLElement) { this.element = container; container.append(this.textarea) }
  scrollToLine() {}
  scrollToBottom() {}
  focus() {}
  onUserInput() { return { dispose() {} } }
  onData() { return { dispose() {} } }
  onBinary() { return { dispose() {} } }
  dispose() { this.textarea.remove() }
} }))
// Output transport is a controlled port; real Viewer, input controller, local zoom and dialog run.
vi.mock('../src/terminal/reader', () => ({ createMobileTerminalReader: ({ report }: { report: (reading: MobileTerminalReading) => void }) => {
  reports.push(report)
  return { setVisible() {}, dispose: async () => {}, retry: async () => {} }
} }))
const roots: ReturnType<typeof createRoot>[] = [], path = 'M12 3L21 20H3Z'
const roles = ['action.read-terminal', 'action.decrease-font-size', 'action.increase-font-size', 'status.terminal-notice'] as const
let release: () => void
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); release = mountThemeRuntime(window) })
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); release(); document.body.replaceChildren(); localStorage.clear(); canvases.length = 0; reports.length = 0 })
async function mount() {
  const write = vi.fn(), resize = vi.fn()
  const client = { runtimeIdentity: () => ({ hostId: 'original-host', instanceId: 'original-runtime' }), agentSession: () => ({ agentSessionId: 'original-session', run: { runId: 'original-run' } }), writeAgent: write, resizeAgent: resize } as unknown as AgentMuxHostedClient
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node); roots.push(root)
  const platform = createBrowserPlatform({ overlayContainer: () => document.body })
  await act(async () => {
    root.render(<MobileTerminalViewer client={client} agentSessionId="original-session" connection={{ state: 'connected', message: 'Original connection' }} platform={platform} visible />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  return { node, write, resize }
}
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const click = async (element: HTMLElement) => act(async () => element.click())
function expectDrawing(element: Element, name: SemanticIconId) { expect(element.querySelector(`use[href="${semanticIconHref(name)}"]`), `Actual mounted ${name} consumer`).not.toBeNull() }
async function changeDrawings() {
  const theme = structuredClone(GRAPHITE_THEME); theme.id = 'custom.terminal-controls'; theme.name = 'Terminal control drawings'
  theme.icons = Object.fromEntries(roles.map(name => [name, { kind: 'paths', paths: [{ d: path, fill: 'currentColor' }] }]))
  await act(async () => expect(previewTheme(theme).applied).toBe(true))
  for (const role of roles) expect(document.getElementById(semanticIconHref(role).slice(1))?.querySelector('path')?.getAttribute('d')).toBe(path)
}
async function zoom(label: string) {
  await act(async () => { button(label).click(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
}

it('actual terminal reading, font controls and notices follow the theme without replacing the terminal or sending remote input', async () => {
  const view = await mount(), original = canvases[0]!, reading = button('终端阅读与状态')
  original.textarea.value = 'Retained original output'
  expectDrawing(reading, 'action.read-terminal')
  expect(reading.querySelector('[aria-label="有待核实事项"]')).toBeNull()
  await act(async () => reports.at(-1)!({ phase: 'reading', message: 'Original saved output', historyBoundary: 'Original boundary', notice: 'Original observation remains unconfirmed' }))
  const notice = reading.querySelector('[aria-label="有待核实事项"]')!
  expectDrawing(notice, 'status.terminal-notice')
  expect(notice.querySelector('svg')?.getAttribute('width')).toBe('6'); expect(notice.querySelector('svg')?.getAttribute('height')).toBe('6')
  await changeDrawings()
  expect(button('终端阅读与状态')).toBe(reading); expect(reading.querySelector('[aria-label="有待核实事项"]')).toBe(notice)
  expect(reading.getAttribute('data-notice')).toBe('true')
  await click(reading)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original observation remains unconfirmed')
  const decrease = button('缩小终端文字'), increase = button('放大终端文字')
  expectDrawing(decrease, 'action.decrease-font-size'); expectDrawing(increase, 'action.increase-font-size')
  await zoom('放大终端文字'); expect(original.options.fontSize).toBe(13)
  await zoom('缩小终端文字'); expect(original.options.fontSize).toBe(12)
  expect(canvases).toHaveLength(1); expect(canvases[0]).toBe(original); expect(original.textarea.value).toBe('Retained original output')
  expect(view.node.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('original-session')
  expect(original.options.disableStdin).toBe(true); expect(view.write).not.toHaveBeenCalled(); expect(view.resize).not.toHaveBeenCalled()
  await click(button('关闭终端阅读'))
  await act(async () => reports.at(-1)!({ phase: 'reading', message: 'Original saved output', historyBoundary: 'Original boundary', notice: null }))
  expect(reading.getAttribute('data-notice')).toBe('false'); expect(reading.querySelector('[aria-label="有待核实事项"]')).toBeNull()
})

it('theme changes keep the exact durable unknown terminal intent and original recovery action', async () => {
  const key = 'agentmux-mobile-terminal-intent-v1:original-session'
  const pending = JSON.stringify({ version: 1, intentId: 'original-intent', runId: 'original-run', kind: 'input', createdAt: fixtureEpoch(0, 0, 12) })
  localStorage.setItem(key, pending)
  const view = await mount(), original = canvases[0]!
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('重启前的终端操作回执未确认')
  await changeDrawings(); await click(button('终端阅读与状态'))
  expect(document.querySelector('.mobile-terminal-details')?.textContent).toContain('original-intent')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === '已在原会话核对，继续新输入')).toBe(true)
  expect(localStorage.getItem(key)).toBe(pending); expect(canvases[0]).toBe(original)
  expect(view.write).not.toHaveBeenCalled(); expect(view.resize).not.toHaveBeenCalled()
})
