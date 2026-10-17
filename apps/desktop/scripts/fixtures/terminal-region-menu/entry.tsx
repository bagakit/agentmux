import '../agent-region-identity-menu/entry'
import type { Terminal } from '@xterm/xterm'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import type { RuntimeEvent } from '../../../src/shared/contracts'

// The existing producer mounts WorkspaceWorkbench -> SessionPane -> real TerminalView.
// Only preview API I/O is controlled; all menu roots, terminal handlers and theme styles are real.
const identity = (window as any).identityMenu
const inputs: unknown[] = [], gestures: unknown[] = []
const outputListeners = new Set<(event: RuntimeEvent) => void>(), outputCursors = new Map<string, number>()
const originalEvents = api.sessions.onEvent, originalAttach = api.sessions.attach
api.sessions.onEvent = listener => {
  outputListeners.add(listener)
  const release = originalEvents(listener)
  return () => { outputListeners.delete(listener); release() }
}
api.sessions.attach = async (...args) => {
  const result = await originalAttach(...args)
  const size = result.currentSize ?? { cols: 80, rows: 24 }
  outputCursors.set(result.session.control.run.runId, 0)
  return { ...result, session: { ...result.session, latestOutputBytes: 0 }, replay: [], gap: null,
    terminal: { type: 'basic-vt', checkpoint: { runId: result.session.control.run.runId,
      throughByte: 0, resizeRevision: result.resizeRevision, size, restoreSize: size,
      restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: new TextEncoder().encode('\u001b[H'), resizes: [] } }
}
const originalWrite = api.sessions.write, originalPaste = api.sessions.paste
api.sessions.write = (...args) => { inputs.push({ operation: 'write', args }); return originalWrite(...args) }
api.sessions.paste = (...args) => { inputs.push({ operation: 'paste', args }); return originalPaste(...args) }
for (const type of ['pointerdown', 'contextmenu', 'keydown']) document.addEventListener(type, event => {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.terminal-view')) gestures.push({ type, trusted: event.isTrusted,
    key: event instanceof KeyboardEvent ? event.key : undefined,
    pointerType: event instanceof PointerEvent ? event.pointerType : undefined })
}, true)
function terminal(): Terminal {
  const element = document.querySelector('[data-workbench-region-id="region-actions-target"] .xterm')
  const record = ((window as any).identityTerminals as { terminal: Terminal; disposed: boolean }[])
    .find(item => !item.disposed && item.terminal.element === element)
  if (!record) throw new Error('The actual original terminal is not mounted')
  return record.terminal
}
async function write(text: string) { await new Promise<void>(done => terminal().write(text, done)) }
Object.assign(window, { terminalMenu: {
  seed() { const generation = identity.mode('terminal'); identity.menuSource('confirmed'); return generation },
  async prepare() {
    terminal().reset()
    await write('src/original.txt\r\nOriginal retained terminal output\r\n')
    inputs.length = 0; gestures.length = 0
  },
  async mouseReporting(enabled: boolean) { terminal().clearSelection(); await write(enabled ? '\u001b[?1000h' : '\u001b[?1000l') },
  appendOutput() {
    const id = identity.facts().tab.regions['region-actions-target'].sessionId
    const session = useAppStore.getState().sessions.find(session => session.id === id)!
    const startByte = outputCursors.get(session.control.run.runId)
    if (startByte === undefined || outputListeners.size === 0) throw new Error('The original output consumer must be attached')
    const data = '\u001b[?1049h\u001b[HFresh output while the menu is open\r\n', dataBytes = new TextEncoder().encode(data)
    outputCursors.set(session.control.run.runId, startByte + dataBytes.length)
    const event = { type: 'core', hostId: session.hostId, event: { type: 'terminal-output', run: session.control.run,
      data, dataBytes, evidence: { outputByteRange: { startByte, endByte: startByte + dataBytes.length } } } } as RuntimeEvent
    for (const listener of outputListeners) listener(event)
  },
  select() { terminal().select(0, 0, 'src/original.txt'.length) },
  clearInputs() { inputs.length = 0; gestures.length = 0 },
  facts() { return { ...identity.facts(), terminal: identity.terminal(), inputs: [...inputs], gestures: [...gestures],
    outputLine: terminal().buffer.active.getLine(0)?.translateToString(true), selected: terminal().getSelection(), mouseTrackingMode: terminal().modes.mouseTrackingMode } }
} })
