// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { RegionContextMenu } from '../src/renderer/src/components/RegionContextMenu'
import * as regionMenu from '../src/renderer/src/components/RegionContextMenu'
import { api } from '../src/renderer/src/lib/api'
import { formatRegionAddress, formatSessionAddress } from '../src/renderer/src/lib/agent-address'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import * as store from '../src/renderer/src/store'

// Real browser xterm parser, buffers, selection, key handler and input subscriptions.
// Synthetic DOM geometry and graphical addons are controlled; neither product menu is mocked.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], listeners: new Set<(event: RuntimeEvent) => void>() }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
    refresh() {}
    onRender = () => ({ dispose() {} })
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} clearDecorations() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', async () => {
  const { TerminalViewportSynchronizer } = await vi.importActual<typeof import('../src/renderer/src/lib/terminal-viewport-sync')>('../src/renderer/src/lib/terminal-viewport-sync')
  return { TerminalViewportSynchronizer: class extends TerminalViewportSynchronizer { observeViewport() {} async startLiveSynchronization() {} } }
})

const initial = store.useAppStore.getState(), original = composerSession('original-menu-agent')
const origin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'original-tab', regionId: 'original-region' }
const output = 'src/original.txt\r\nOriginal retained output\r\n'
let root: Root, container: HTMLDivElement
let copy: MockInstance<typeof api.ui.writeClipboardText>

function attachment(session: SessionSnapshot): SessionAttachResult {
  return { attachmentId: `attachment-${session.control.run.runId}`, session: { ...session, latestOutputBytes: output.length },
    currentSize: { cols: 80, rows: 24 }, resizeRevision: 0, terminal: { type: 'unknown', reason: 'origin_unknown' }, gap: null,
    replay: [{ type: 'data', runId: session.control.run.runId, data: output, dataBytes: new TextEncoder().encode(output), startByte: 0, endByte: output.length }] }
}
function scene(session: SessionSnapshot, readOnly = false, standalone = false): ReactNode {
  const terminal = <TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false}
    readOnly={readOnly} linkOrigin={origin} />
  return standalone ? terminal : <RegionContextMenu tabId={origin.tabId} regionId={origin.regionId}
    agentSessionId={session.kind === 'agent' ? session.control.agentSessionId : null}
    writeClipboardText={api.ui.writeClipboardText} splitMenu={[{ kind: 'split', direction: 'right', label: 'Split Right', onSelect() {} }]} swapMenu={[]}>
    <section data-original-region="">
      <AgentRegionHeader name={session.label} executorLabel="Original executor" sessionId={session.id} sessionKind={session.kind}
        executionHost={{ id: session.hostId, label: 'Original Host', configured: true, kind: 'local', cwd: session.workspacePath }}
        regionId={origin.regionId} nativeSession={session} readOnly={readOnly} onHistory={undefined} />
      {terminal}
    </section>
  </RegionContextMenu>
}
async function mount(session: SessionSnapshot = original, readOnly = false, standalone = false) {
  store.useAppStore.setState({ sessions: [session] })
  await act(async () => root.render(scene(session, readOnly, standalone)))
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId,
    sessionId: session.id, runId: session.control.run.runId })?.liveReady).toBe(true)))
  const terminal = fixture.terminals.at(-1)!
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('src/original.txt')
  return terminal
}
function body() { const found = container.querySelector<HTMLElement>('.xterm-screen'); expect(found).not.toBeNull(); return found! }
function menu() { return document.querySelector<HTMLElement>('[role="menu"][data-state="open"]') }
function item(label: string, root: ParentNode = menu()!) {
  const found = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(node => (node.getAttribute('aria-label') ?? node.querySelector('span')?.textContent ?? node.textContent)?.trim() === label)
  expect(found, `Original ${label} action`).toBeDefined(); return found!
}
async function openBody() {
  await act(async () => {
    body().dispatchEvent(new PointerEvent('pointerdown', { button: 2, buttons: 2, pointerType: 'mouse', clientX: 20, clientY: 8, bubbles: true, cancelable: true }))
    body().dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: 20, clientY: 8, bubbles: true, cancelable: true }))
  })
  await vi.waitFor(() => expect(menu()).not.toBeNull())
  expect(document.querySelectorAll('[role="menu"][data-state="open"]')).toHaveLength(1)
  return menu()!
}
async function close() {
  if (menu()) await act(async () => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(menu()).toBeNull())
}
async function openMore() {
  const trigger = container.querySelector<HTMLElement>('.agent-region-header__more')!
  expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(menu()).not.toBeNull())
  return menu()!
}
async function write(terminal: BrowserTerminal, text: string) { await act(async () => await new Promise<void>(done => terminal.write(text, done))) }
function watchFocusScopeClose(node: HTMLElement) {
  const events: Event[] = []
  node.addEventListener('focusScope.autoFocusOnUnmount', event => events.push(event))
  return async () => {
    await vi.waitFor(() => expect(events, 'the real Radix FocusScope unmount event is nonempty').toHaveLength(1))
    expect(events[0]!.defaultPrevented, 'terminal source retains responsibility for cancelling default focus').toBe(true)
  }
}
function laterChoice() {
  const button = document.createElement('button'); button.textContent = 'Later deliberate choice'; document.body.append(button); return button
}
function plainSession(): SessionSnapshot {
  return { ...original, id: 'original-terminal', kind: 'terminal', providerId: null,
    control: { kind: 'terminal', hostId: 'local', runId: 'original-terminal-run', run: { runId: 'original-terminal-run' } } }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('OffscreenCanvas', undefined)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '',
    measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 }) }) as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('xterm-char-measure-element') ? 256 : 640 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, width: 640, height: 384, right: 640, bottom: 384, toJSON() {} })
  fixture.terminals.length = 0; fixture.listeners.clear()
  vi.spyOn(api.sessions, 'attach').mockImplementation(async control => {
    const session = store.useAppStore.getState().sessions.find(row => row.hostId === control.hostId
      && row.control.kind === control.kind && row.control.run.runId === control.run.runId
      && (control.kind !== 'agent' || row.control.kind === 'agent' && row.control.agentSessionId === control.agentSessionId))
    expect(session, 'the fixture admits only its exact requested owner').toBeDefined()
    return attachment(session!)
  })
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener) } })
  vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'paste').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'readClipboardText').mockResolvedValue('original paste')
  copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(store, 'agentRegionExecution').mockReturnValue({ hostId: original.hostId, cwd: original.workspacePath })
  store.useAppStore.setState({ config: composerConfig, sessions: [original], agentNames: {}, agentComposerDrafts: { [original.id]: 'Original unsent draft' } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren(); store.useAppStore.setState(initial, true); fixture.listeners.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('the real terminal body reaches its one Agent menu, compact original tools and exact link callbacks', async () => {
  await mount()
  const opened = await openBody()
  expect(opened.classList.contains('agent-region-menu')).toBe(true)
  expect(item('Split Right', opened)).toBeDefined()
  const links = [...opened.querySelectorAll('[role="menuitem"]')].filter(node => node.getAttribute('aria-label') === 'Copy Agent Link')
  expect(links).toHaveLength(1)
  expect(item('Copy Region Link', opened)).toBeDefined()
  for (const label of ['Copy', 'Copy visible output', 'Copy all output', 'Paste', 'Select all', 'Find', 'Scroll to bottom', 'Clear terminal']) expect(item(label, opened)).toBeDefined()
  expect(item('Copy', opened).hasAttribute('data-disabled')).toBe(true)
  await act(async () => item('Copy Agent Link', opened).click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatSessionAddress(original.control.agentSessionId))
  await openBody(); await act(async () => item('Copy Region Link').click())
  expect(copy).toHaveBeenLastCalledWith(formatRegionAddress(origin.regionId))
  expect(store.useAppStore.getState().agentComposerDrafts[original.id]).toBe('Original unsent draft')
})

it('unknown spatial observation retains one exact Agent identity from the actual terminal source', async () => {
  vi.mocked(store.agentRegionExecution).mockReturnValue(null)
  await mount({ ...original, id: 'host-qualified-original-view' }); const opened = await openBody()
  expect(opened.classList.contains('agent-region-menu')).toBe(true)
  expect([...opened.querySelectorAll('[role="menuitem"]')].filter(node => node.getAttribute('aria-label') === 'Copy Agent Link')).toHaveLength(1)
  await act(async () => item('Copy Agent Link', opened).click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatSessionAddress(original.control.agentSessionId))
  expect(api.sessions.write).not.toHaveBeenCalled(); expect(api.sessions.paste).not.toHaveBeenCalled()
})

it('reads mouse reporting and selection from the opened real terminal and retains visible-output copying', async () => {
  const terminal = await mount()
  await write(terminal, '\u001b[?1000h')
  let opened = await openBody()
  expect(item('Copy', opened).hasAttribute('data-disabled')).toBe(true)
  expect(opened.querySelector('[role="note"]')?.textContent).toMatch(/drag/i)
  await act(async () => item('Copy visible output', opened).click())
  expect(copy).toHaveBeenCalledOnce(); expect(copy.mock.calls[0]![0]).toContain('Original retained output')
  await act(async () => terminal.select(0, 0, 'src/original.txt'.length))
  opened = await openBody(); expect(item('Copy', opened).hasAttribute('data-disabled')).toBe(false)
  await act(async () => item('Copy', opened).click())
  expect(copy).toHaveBeenLastCalledWith('src/original.txt')
})

it('retains the file action resolved under the real context pointer in its original workspace', async () => {
  const reveal = vi.spyOn(api.files, 'reveal').mockResolvedValue(undefined)
  await mount(); const opened = await openBody()
  const path = opened.querySelector<HTMLElement>('[role="menuitem"][title*="src/original.txt"]')
  expect(path).not.toBeNull()
  await act(async () => path!.click())
  expect(reveal).toHaveBeenCalledExactlyOnceWith(origin.workspaceId, 'src/original.txt')
})

it('the real artifact pointer opens the original file through its typed system seam', async () => {
  const openSystem = vi.spyOn(api.files, 'openSystem').mockResolvedValue(undefined)
  const terminal = await mount(); terminal.reset(); await write(terminal, 'dist/original.dmg\r\n')
  const opened = await openBody()
  expect(opened.querySelectorAll('[role="menuitem"][title*="dist/original.dmg"]')).toHaveLength(2)
  await act(async () => item('Open with system', opened).click())
  expect(openSystem).toHaveBeenCalledExactlyOnceWith(origin.workspaceId, 'dist/original.dmg')
})

it.each([{ key: 'ContextMenu', code: 'ContextMenu', keyCode: 93, shiftKey: false }, { key: 'F10', code: 'F10', keyCode: 121, shiftKey: true }])(
  '$key opens from the actual xterm input without delivering a PTY key', async chord => {
    await mount(); const input = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
    expect(input).not.toBeNull(); input.focus()
    const event = new KeyboardEvent('keydown', { ...chord, bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(event))
    await vi.waitFor(() => expect(menu()?.classList.contains('agent-region-menu')).toBe(true))
    expect(event.defaultPrevented).toBe(true); expect(item('Copy visible output')).toBeDefined()
    expect(menu()!.querySelector('[title*="src/original.txt"]')).toBeNull()
    expect(api.sessions.write).not.toHaveBeenCalled(); expect(api.sessions.paste).not.toHaveBeenCalled()
  })

it('an IME-owned menu chord does not open the terminal menu', async () => {
  await mount(); const input = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', keyCode: 121, shiftKey: true, isComposing: true, bubbles: true, cancelable: true })))
  expect(menu()).toBeNull()
})

it('More has no terminal residue after a body menu closes', async () => {
  await mount(); await openBody(); expect(item('Copy visible output')).toBeDefined(); await close()
  const opened = await openMore()
  expect([...opened.querySelectorAll('[role="menuitem"]')].some(node => node.getAttribute('aria-label') === 'Copy visible output')).toBe(false)
  expect(item('Copy Region Link', opened)).toBeDefined()
})

it('modal isolation and live output keep the original open terminal tools available', async () => {
  vi.mocked(api.sessions.attach).mockImplementation(async control => {
    expect(control).toEqual(original.control)
    return { ...attachment(original), terminal: { type: 'basic-vt', checkpoint: { runId: original.control.run.runId,
      throughByte: 0, resizeRevision: 0, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 },
      restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: new TextEncoder().encode('\u001b[H'), resizes: [] } }
  })
  const terminal = await mount(), opened = await openBody()
  const source = container.querySelector<HTMLElement>('.terminal-context-source')!
  await vi.waitFor(() => expect(source.closest('[aria-hidden="true"]'), 'the actual Radix modal isolates its original surface').not.toBeNull())
  expect(source.closest('[hidden], [inert]')).toBeNull()
  const data = '\u001b[?1049h\u001b[HLive menu output\r\n', dataBytes = new TextEncoder().encode(data)
  await act(async () => {
    const event = { type: 'core', hostId: original.hostId, event: { type: 'terminal-output', run: original.control.run,
      data, dataBytes, evidence: { outputByteRange: { startByte: output.length, endByte: output.length + dataBytes.length } } } } as RuntimeEvent
    expect(fixture.listeners.size, 'the actual output consumer is subscribed').toBeGreaterThan(0)
    for (const listener of fixture.listeners) listener(event)
  })
  await act(async () => await vi.waitFor(() => expect(terminal.buffer.active.type).toBe('alternate')))
  await vi.waitFor(() => expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Live menu output'))
  expect(menu(), 'normal output preserves the same popup').toBe(opened)
  expect(opened.querySelector('[data-terminal-menu-tools]')).not.toBeNull()
  expect(opened.textContent).toContain('The full-screen buffer has no terminal scrollback.')
  await act(async () => item('Copy visible output', opened).click())
  expect(copy).toHaveBeenCalledOnce(); expect(copy.mock.calls[0]![0]).toContain('Live menu output')
  expect(fixture.terminals).toHaveLength(1)
  expect(store.useAppStore.getState().agentComposerDrafts[original.id]).toBe('Original unsent draft')
})

it.each(['pointerup', 'pointercancel', 'pointermove'])(
  'a consumed context gesture retains its tools when %s precedes the React commit', async type => {
    await mount(); const target = body()
    await act(async () => {
      target.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerType: 'touch', pointerId: 1,
        clientX: 20, clientY: 8, bubbles: true, cancelable: true }))
      target.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: 20, clientY: 8, bubbles: true, cancelable: true }))
      // The source has been read synchronously, but the opening render has not committed yet.
      target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 1, bubbles: true, cancelable: true }))
    })
    await vi.waitFor(() => expect(menu()).not.toBeNull())
    expect(document.querySelectorAll('[role="menu"][data-state="open"]')).toHaveLength(1)
    expect(menu()!.querySelector('[data-terminal-menu-tools]')).not.toBeNull()
    expect(item('Copy visible output')).toBeDefined()
    expect(api.sessions.write).not.toHaveBeenCalled(); expect(api.sessions.paste).not.toHaveBeenCalled()
  })

it('Escape returns focus to the actual original xterm through its real FocusScope close event', async () => {
  await mount(); const input = container.querySelector<HTMLElement>('.xterm-helper-textarea')!
  input.focus(); const opened = await openBody(), closed = watchFocusScopeClose(opened)
  await close(); await closed()
  expect(document.activeElement).toBe(input)
})

it('a deliberate external focus after menu removal survives the deferred FocusScope callback', async () => {
  await mount(); const opened = await openBody(), closed = watchFocusScopeClose(opened), choice = laterChoice()
  await act(async () => {
    flushSync(() => opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(menu()).toBeNull(); choice.focus()
  })
  await closed(); expect(document.activeElement).toBe(choice)
})

it.each(['hidden', 'inert'])('clearing a %s source cannot release default FocusScope focus cancellation', async attribute => {
  await mount(); const opened = await openBody(), closed = watchFocusScopeClose(opened), choice = laterChoice()
  await act(async () => {
    const source = container.querySelector<HTMLElement>('[data-original-region]')!
    source.setAttribute(attribute, '')
    root.render(scene({ ...original, label: 'Current presentation' }))
  })
  expect(document.querySelector('[data-terminal-menu-tools]')).toBeNull()
  await act(async () => {
    flushSync(() => opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    choice.focus()
  })
  await closed(); expect(document.activeElement).toBe(choice)
})

it('More replacement clears the source while the previous real FocusScope still cancels default focus', async () => {
  await mount(); const opened = await openBody(), closed = watchFocusScopeClose(opened)
  await openMore(); await closed()
  expect(menu()?.dataset.menuEntry).toBe('more')
  expect(document.querySelector('[data-terminal-menu-tools]')).toBeNull()
})

it('touch long-press on the real terminal body uses the same Root and original tools', async () => {
  await mount()
  await act(async () => body().dispatchEvent(new PointerEvent('pointerdown', {
    button: 0, pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 8, bubbles: true, cancelable: true
  })))
  await vi.waitFor(() => expect(menu()?.classList.contains('agent-region-menu')).toBe(true), { timeout: 1500 })
  expect(document.querySelectorAll('[role="menu"][data-state="open"]')).toHaveLength(1)
  expect(item('Copy visible output')).toBeDefined()
  await act(async () => body().dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', bubbles: true })))
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('replacing the exact Run clears the prior terminal source before another gesture', async () => {
  const first = await mount(), opened = await openBody(), closed = watchFocusScopeClose(opened)
  expect(item('Copy visible output')).toBeDefined()
  const replacement = { ...original, control: { ...original.control, run: { runId: 'replacement-menu-run' } } }
  const current = await mount(replacement)
  expect(current).not.toBe(first)
  expect(fixture.terminals).toHaveLength(2)
  expect(document.querySelector('[data-terminal-menu-tools]')).toBeNull()
  const choice = laterChoice()
  await act(async () => {
    flushSync(() => opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    choice.focus()
  })
  await closed(); expect(document.activeElement).toBe(choice)
  await openBody()
  expect(item('Copy visible output')).toBeDefined()
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('the writable compact Paste action reaches only its original exact control with the clipboard text', async () => {
  await mount(); const opened = await openBody()
  await act(async () => item('Paste', opened).click())
  await vi.waitFor(() => expect(api.sessions.paste).toHaveBeenCalledOnce())
  const [control, text, terminalData] = vi.mocked(api.sessions.paste).mock.calls[0]!
  expect(control).toEqual(original.control)
  expect(text).toBe('original paste'); expect(terminalData).toBe('original paste')
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('read-only body menus retain reading tools and cannot paste into the healthy original Run', async () => {
  await mount(original, true); const opened = await openBody()
  expect(item('Copy all output', opened)).toBeDefined()
  await act(async () => item('Paste', opened).click())
  await act(async () => await Promise.resolve())
  expect(api.sessions.write).not.toHaveBeenCalled(); expect(api.sessions.paste).not.toHaveBeenCalled()
  expect(store.useAppStore.getState().sessions[0]!.control).toEqual(original.control)
})

it.each([false, true])('a plain terminal preserves its tools without manufacturing Agent actions (standalone=%s)', async standalone => {
  await mount(plainSession(), false, standalone); const opened = await openBody()
  expect(item('Copy visible output', opened)).toBeDefined()
  expect([...opened.querySelectorAll('[role="menuitem"]')].some(node => node.getAttribute('aria-label') === 'Copy Agent Link' || node.textContent?.trim() === 'Stop Agent')).toBe(false)
  await act(async () => item('Copy visible output', opened).click())
  expect(copy).toHaveBeenCalledOnce(); expect(copy.mock.calls[0]![0]).toContain('Original retained output')
})

it('closed live output reaches the real buffer without publishing terminal tools through the Region parent', async () => {
  const terminal = await mount(), entries = vi.spyOn(regionMenu, 'useRegionMenuEntries')
  await openMore(); expect(entries, 'the observer sees the actual Header consumer').toHaveBeenCalled(); await close()
  entries.mockClear()
  let afterByte = output.length
  for (let i = 0; i < 12; i++) {
    const data = `live-${i}\r\n`, startByte = afterByte; afterByte += data.length
    await act(async () => {
      const event = { type: 'core', hostId: original.hostId, event: { type: 'terminal-output', run: original.control.run,
        data, dataBytes: new TextEncoder().encode(data), evidence: { outputByteRange: { startByte, endByte: afterByte } } } } as RuntimeEvent
      for (const listener of fixture.listeners) listener(event)
    })
  }
  await act(async () => await vi.waitFor(() => expect(Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)).join('\n')).toContain('live-11')))
  expect(entries, 'closed terminal output does not render its sibling Header menu').not.toHaveBeenCalled()
  expect(menu()).toBeNull(); expect(api.sessions.write).not.toHaveBeenCalled()
})
