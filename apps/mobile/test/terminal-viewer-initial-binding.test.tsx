import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileTerminalViewer } from '../src/terminal/MobileTerminalViewer'

// This mounted check isolates initial control ownership. Output parsing and
// actual xterm/Host transport retain their separate production-chain evidence.
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: Record<string, unknown>
  textarea = document.createElement('textarea')
  parser = { registerOscHandler: () => ({ dispose() {} }) }
  constructor(options: Record<string, unknown>) { this.options = options }
  open(container: HTMLElement) { container.appendChild(this.textarea) }
  onUserInput() { return { dispose() {} } }
  onData() { return { dispose() {} } }
  onBinary() { return { dispose() {} } }
  dispose() { this.textarea.remove() }
} }))
vi.mock('../src/terminal/reader', () => ({ createMobileTerminalReader: () => ({
  setVisible() {}, dispose: async () => {}, retry: async () => {}
}) }))
const key = 'agentmux-mobile-terminal-intent-v1:initial-original-session'
const connection = { state: 'connected' as const, message: '原连接' }
const platform = { copyText: async () => true } as Parameters<typeof MobileTerminalViewer>[0]['platform']
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ''; localStorage.clear() })

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
  const original = JSON.stringify({ version: 1, intentId: 'original-intent', runId: 'original-run', kind: 'input', createdAt: 12 })
  localStorage.setItem(key, original)
  const p = port(), view = await mount(p.client)
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).toContain('重启前的终端操作回执未确认')
  expect(view.node.querySelector('.mobile-terminal-notice')?.textContent).not.toContain('连接已变化')
  expect(view.node.querySelector('.mobile-terminal-details')?.textContent).toContain('original-intent')
  expect(localStorage.getItem(key)).toBe(original)
  expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
})

it('reads horizontal terminal overflow through the original touch viewport while preserving vertical events and passive input', async () => {
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
    expect((await touch('touchmove', 150, 302)).defaultPrevented).toBe(false)
    expect(canvas.scrollLeft).toBe(140)
    await touch('touchend', 150, 302)
    await touch('touchstart', 270, 300)
    expect((await touch('touchmove', 268, 180)).defaultPrevented).toBe(false)
    expect(canvas.scrollLeft).toBe(140)
    await touch('touchcancel', 268, 180)
    await touch('touchmove', 120, 300)
    expect(canvas.scrollLeft).toBe(140)
    await touch('touchstart', 270, 300)
    await view.render(p.client, false)
    await touch('touchmove', 150, 300)
    expect(canvas.scrollLeft).toBe(140)
    expect(moves).toHaveLength(4)
    expect(p.write).not.toHaveBeenCalled(); expect(p.resize).not.toHaveBeenCalled()
  } finally { document.removeEventListener('touchmove', observe) }
})
