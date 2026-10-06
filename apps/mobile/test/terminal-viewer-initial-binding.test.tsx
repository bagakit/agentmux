const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileTerminalReading } from '../src/terminal/reader'
import { MobileTerminalViewer } from '../src/terminal/MobileTerminalViewer'

const canvases = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; textarea: HTMLTextAreaElement }>)
const readings = vi.hoisted(() => [] as Array<(reading: MobileTerminalReading) => void>)

// This mounted check isolates initial control ownership. Output parsing and
// actual xterm/Host transport retain their separate production-chain evidence.
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: Record<string, unknown>
  textarea = document.createElement('textarea')
  rows = 24
  buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } }
  element: HTMLElement | undefined
  parser = { registerOscHandler: () => ({ dispose() {} }) }
  constructor(options: Record<string, unknown>) { this.options = options; canvases.push(this) }
  open(container: HTMLElement) { this.element = container; container.appendChild(this.textarea) }
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
const platform = { copyText: async () => true } as Parameters<typeof MobileTerminalViewer>[0]['platform']
const roots: ReturnType<typeof createRoot>[] = []
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
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

it('mounted initial Viewer keeps its constructor watch notice; a different SDK still explicitly returns to watch without input', async () => {
  const first = port(), view = await mount(first.client)
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('观看不发送输入')
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).not.toContain('连接已变化')
  const next = port(); await view.render(next.client)
  expect(view.node.querySelector('.mobile-terminal')?.getAttribute('data-control')).toBe('watch')
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('连接已变化')
  for (const p of [first, next]) { expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled() }
})

it('mounted first binding retains the exact durable unknown intent and original diagnostic without claiming a connection change', async () => {
  const original = JSON.stringify({ version: 1, intentId: 'original-intent', runId: 'original-run', kind: 'input', createdAt: _reshape_fixtureEpoch(0, 0, 12) })
  localStorage.setItem(key, original)
  const p = port(), view = await mount(p.client)
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('重启前的终端操作回执未确认')
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).not.toContain('连接已变化')
  expect(view.node.querySelector('.mobile-terminal-details')?.textContent).toContain('original-intent')
  expect(localStorage.getItem(key)).toBe(original)
  expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
  expect([...view.node.querySelectorAll('.mobile-terminal-notice > p')].map(node => node.textContent)).toContain('终端操作回执未确认；原操作不会重发。')
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

it('keeps reading, boundary and idle input diagnostics directly visible after toolbar compression', async () => {
  const p = port(), view = await mount(p.client)
  const report = readings.at(-1)!, message = '同一显示文案；具体事实由原 owner 给出。'
  await act(async () => report({ phase: 'reading', message, historyBoundary: null }))
  expect([...view.node.querySelectorAll('.mobile-terminal-notice > p')].map(node => node.textContent)).toEqual(['同一显示文案', '观看不发送输入'])
  expect(view.node.querySelector('.mobile-terminal-details')?.textContent).toContain(message)
  expect(view.node.querySelector<HTMLDetailsElement>('.mobile-terminal-details')?.open).toBe(false)
  await act(async () => report({ phase: 'reading', message, historyBoundary: '原历史边界' }))
  expect([...view.node.querySelectorAll('.mobile-terminal-notice > p')].map(node => node.textContent)).toEqual(['同一显示文案', '观看不发送输入', '原历史边界'])
  vi.spyOn(p.client, 'runtimeIdentity').mockImplementation(() => { throw new Error('原 owner 身份仍未知') })
  await act(async () => view.node.querySelector<HTMLButtonElement>('.mobile-terminal-mode')!.click())
  expect(view.node.querySelector('.mobile-terminal')?.getAttribute('data-control')).toBe('watch')
  expect([...view.node.querySelectorAll('.mobile-terminal-notice > p')].map(node => node.textContent)).toContain('原会话身份尚未核实，可在 Mac 继续操作')
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
