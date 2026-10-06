const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileTerminalReading } from '../src/terminal/reader'
import { MobileTerminalViewer } from '../src/terminal/MobileTerminalViewer'

const canvases = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; textarea: HTMLTextAreaElement }>)
const selectedText = vi.hoisted(() => ({ value: 'Retained terminal selection' }))
const unicodeRefusal = vi.hoisted(() => ({ active: false }))
const readings = vi.hoisted(() => [] as Array<(reading: MobileTerminalReading) => void>)

// This mounted check isolates initial control ownership. Output parsing and
// actual xterm/Host transport retain their separate production-chain evidence.
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: Record<string, unknown>
  unicode = { activeVersion: '6' }
  loadAddon() { if (unicodeRefusal.active) throw new Error('Width configuration unavailable') }
  textarea = document.createElement('textarea')
  rows = 24
  buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } }
  element: HTMLElement | undefined
  parser = { registerOscHandler: () => ({ dispose() {} }) }
  constructor(options: Record<string, unknown>) { this.options = options; canvases.push(this) }
  open(container: HTMLElement) { this.element = container; container.appendChild(this.textarea) }
  getSelection() { return selectedText.value }
  scrollToLine() {}
  focus() {}
  onUserInput() { return { dispose() {} } }
  onData() { return { dispose() {} } }
  onBinary() { return { dispose() {} } }
  dispose() { this.textarea.remove() }
} }))
vi.mock('../src/terminal/reader', () => ({ createMobileTerminalReader: ({ report }: { report: (reading: MobileTerminalReading) => void }) => {
  readings.push(report)
  return { setVisible() {}, dispose: async () => {}, retry: async () => {} }
} }))
const key = 'agentmux-mobile-terminal-intent-v1:initial-original-session'
const connection = { state: 'connected' as const, message: '原连接' }
const platform = { copyText: async () => true, overlayContainer: () => document.body } as Parameters<typeof MobileTerminalViewer>[0]['platform']
const roots: ReturnType<typeof createRoot>[] = []
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; unicodeRefusal.active = false; selectedText.value = 'Retained terminal selection' })
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ''; localStorage.clear(); canvases.length = 0; readings.length = 0 })

function port() {
  const write = vi.fn(), resize = vi.fn()
  const client = { runtimeIdentity: () => ({ hostId: 'original-host', instanceId: 'original-runtime' }),
    agentSession: () => ({ agentSessionId: 'initial-original-session', run: { runId: 'original-run' } }), writeAgent: write, resizeAgent: resize } as unknown as AgentMuxHostedClient
  return { client, write, resize }
}
async function mount(client: AgentMuxHostedClient) {
  const node = document.createElement('div'); document.body.appendChild(node)
  const root = createRoot(node); roots.push(root)
  const render = async (client: AgentMuxHostedClient, visible = true) => { await act(async () => {
    root.render(<MobileTerminalViewer client={client} agentSessionId="initial-original-session" connection={connection} platform={platform} visible={visible} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }) }
  await render(client); return { node, render }
}

async function openReading(node: HTMLElement) {
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="终端阅读与状态"]')!.click())
  return document.querySelector<HTMLElement>('.mobile-terminal-details')!
}

it('keeps normal watch information on demand across SDK replacement without submitting input', async () => {
  const first = port(), view = await mount(first.client)
  expect(view.node.querySelector('.mobile-terminal-notice')).toBeNull()
  const details = await openReading(view.node)
  expect(details.textContent).toContain('观看不发送输入')
  expect(details.textContent).not.toContain('连接已变化')
  const next = port(); await view.render(next.client)
  expect(view.node.querySelector('.mobile-terminal')?.getAttribute('data-control')).toBe('watch')
  expect(details.textContent).toContain('连接已变化')
  for (const p of [first, next]) { expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled() }
})

it('retains the exact durable unknown intent with a marked information entry and original recovery action', async () => {
  const original = JSON.stringify({ version: 1, intentId: 'original-intent', runId: 'original-run', kind: 'input', createdAt: _reshape_fixtureEpoch(0, 0, 12) })
  localStorage.setItem(key, original)
  const p = port(), view = await mount(p.client)
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('重启前的终端操作回执未确认')
  expect(view.node.querySelector('[aria-label="终端阅读与状态"]')?.getAttribute('data-notice')).toBe('true')
  const details = await openReading(view.node)
  expect(details.textContent).toContain('original-intent')
  expect([...details.querySelectorAll('button')].some(button => button.textContent === '已在原会话核对，继续新输入')).toBe(true)
  expect(localStorage.getItem(key)).toBe(original)
  expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
  expect(view.node.querySelector<HTMLButtonElement>('.mobile-terminal-mode')?.disabled).toBe(true)
})

it('keeps one toolbar mode switch and exposes PTY size and keys only during explicit control', async () => {
  const p = port(), view = await mount(p.client)
  expect(view.node.querySelector('.mobile-terminal-toolbar .mobile-terminal-mode')?.textContent).toBe('控制终端')
  expect(view.node.querySelector('.mobile-terminal-actions')).toBeNull()
  expect(view.node.querySelector('.mobile-terminal-keys')).toBeNull()
  await act(async () => view.node.querySelector<HTMLButtonElement>('.mobile-terminal-mode')!.click())
  const size = view.node.querySelector<HTMLButtonElement>('.mobile-terminal-keys > button')!
  expect(size.textContent).toBe('PTY 尺寸'); expect(size.disabled).toBe(false)
  expect(view.node.querySelector('[aria-label="终端 Esc"]')).not.toBeNull()
  await act(async () => size.click())
  expect(view.node.querySelector('.mobile-terminal-size')).not.toBeNull()
  await act(async () => view.node.querySelector<HTMLButtonElement>('.mobile-terminal-mode')!.click())
  expect(view.node.querySelector('.mobile-terminal-size')).toBeNull()
  expect(view.node.querySelector('.mobile-terminal-keys')).toBeNull()
  expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
})

it('uses explicit service facts rather than display wording and keeps full boundaries on demand', async () => {
  const p = port(), view = await mount(p.client)
  const report = readings.at(-1)!, message = '完全正常；也可能只是展示文案。'
  await act(async () => report({ phase: 'reading', message, historyBoundary: '原历史边界', notice: null }))
  expect(view.node.querySelector('.mobile-terminal-notice')).toBeNull()
  const details = await openReading(view.node)
  expect(details.textContent).toContain(message); expect(details.textContent).toContain('原历史边界')
  await act(async () => report({ phase: 'reading', message, historyBoundary: null, notice: '原输出连接未知' }))
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('原输出连接未知')
  expect(details.textContent).toContain('原输出连接未知')
  expect(details.textContent).toContain(message)
  await act(async () => report({ phase: 'reading', message, historyBoundary: null, notice: null }))
  expect(view.node.querySelector('.mobile-terminal-notice')).toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭终端阅读"]')!.click())
  vi.spyOn(p.client, 'runtimeIdentity').mockImplementation(() => { throw new Error('原 owner 身份仍未知') })
  await act(async () => view.node.querySelector<HTMLButtonElement>('.mobile-terminal-mode')!.click())
  expect(view.node.querySelector('.mobile-terminal')?.getAttribute('data-control')).toBe('watch')
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('原会话身份尚未核实')
  expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
})

it('owns horizontal reading without leaking touch gestures to xterm protocol input, and resets when hidden', async () => {
  const p = port(), view = await mount(p.client), canvas = view.node.querySelector<HTMLDivElement>('.mobile-terminal-canvas')!
  const moves: Event[] = [], observe = (event: Event) => moves.push(event)
  document.addEventListener('touchmove', observe)
  const touch = async (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : [{ identifier: 7, clientX: x, clientY: y }] })
    await act(async () => canvas.dispatchEvent(event)); return event
  }
  try {
    canvas.scrollLeft = 20
    await touch('touchstart', 270, 300)
    expect((await touch('touchmove', 150, 302)).defaultPrevented).toBe(true)
    expect(canvas.scrollLeft).toBe(140)
    await touch('touchend', 150, 302)
    await touch('touchstart', 270, 300)
    expect((await touch('touchmove', 268, 180)).defaultPrevented).toBe(true)
    expect(canvas.scrollLeft).toBe(140)
    await touch('touchcancel', 268, 180)
    await touch('touchmove', 120, 300)
    expect(canvas.scrollLeft).toBe(140)
    await touch('touchstart', 270, 300)
    await view.render(p.client, false)
    await touch('touchmove', 150, 300)
    expect(canvas.scrollLeft).toBe(140)
    expect(moves).toHaveLength(1)
    expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
  } finally { document.removeEventListener('touchmove', observe) }
})


it('applies explicit Host terminal colors to the retained canvas without recreating output or gaining input', async () => {
  const p = port(), node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node); roots.push(root)
  const first = { background: '#152537', red: '#aa3344' }, next = { background: '#f4efe5', red: '#bb2233' }
  const render = async (terminalPalette: typeof first) => act(async () => {
    root.render(<MobileTerminalViewer client={p.client} agentSessionId="initial-original-session" connection={connection} platform={platform} visible terminalPalette={terminalPalette} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  await render(first)
  const canvas = canvases[0]!, textarea = canvas.textarea
  textarea.value = 'Retained native buffer'
  expect(canvas.options.theme).toEqual(first)
  await render(next)
  expect(canvases).toHaveLength(1); expect(canvases[0]).toBe(canvas); expect(canvas.options.theme).toEqual(next)
  expect(canvas.textarea).toBe(textarea); expect(textarea.value).toBe('Retained native buffer')
  expect(canvas.options.disableStdin).toBe(true); expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
})

it('keeps the retained terminal and explicit control available when Unicode configuration fails', async () => {
  unicodeRefusal.active = true
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const p = port(), view = await mount(p.client), original = canvases[0]
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('终端字宽配置尚未生效')
  const details = await openReading(view.node)
  expect(details.textContent).toContain('原输出与输入继续可用')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭终端阅读"]')!.click())
  await act(async () => view.node.querySelector<HTMLButtonElement>('.mobile-terminal-mode')!.click())
  expect(view.node.querySelector('.mobile-terminal')?.getAttribute('data-control')).toBe('control')
  expect(canvases[0]).toBe(original); expect(canvases).toHaveLength(1)
  expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
  warn.mockRestore()
})

it('marks only actual clipboard failure and clears that mark after a confirmed retry without changing the retained terminal', async () => {
  const p = port(), view = await mount(p.client), original = canvases[0]
  const clipboard = vi.spyOn(platform, 'copyText').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const details = await openReading(view.node)
  const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === '复制选中文字')!
  await act(async () => copy.click())
  expect(view.node.querySelector('[aria-label="终端阅读与状态"]')?.getAttribute('data-notice')).toBe('true')
  expect(details.textContent).toContain('复制未完成')
  await act(async () => copy.click())
  expect(details.textContent).toContain('选中文字已复制')
  expect(view.node.querySelector('[aria-label="终端阅读与状态"]')?.getAttribute('data-notice')).toBe('false')
  expect(view.node.querySelector('.mobile-terminal-notice')).toBeNull()
  expect(clipboard.mock.calls.map(call => call[0])).toEqual([selectedText.value, selectedText.value])
  expect(canvases[0]).toBe(original); expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
})

it('keeps original observation issues after successful copy and treats an empty selection as local guidance', async () => {
  const p = port(), view = await mount(p.client)
  const clipboard = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
  await act(async () => readings.at(-1)!({ phase: 'reading', message: '原输出可继续读', historyBoundary: null, notice: '原输出核实未完成' }))
  const details = await openReading(view.node)
  const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === '复制选中文字')!
  await act(async () => copy.click())
  expect(details.textContent).toContain('选中文字已复制')
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toBe('原输出核实未完成')
  await act(async () => readings.at(-1)!({ phase: 'reading', message: '已核实原输出', historyBoundary: null, notice: null }))
  selectedText.value = ''
  await act(async () => copy.click())
  expect(details.textContent).toContain('请先选中需要复制的终端文字')
  expect(view.node.querySelector('.mobile-terminal-notice')).toBeNull()
  expect(clipboard).toHaveBeenCalledTimes(1); expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
})
