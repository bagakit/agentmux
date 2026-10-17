import '../agent-region-identity-menu/entry'
import type { Terminal } from '@xterm/xterm'
import { api } from '../../../src/renderer/src/lib/api'

// The existing producer mounts WorkspaceWorkbench -> SessionPane -> real TerminalView.
// Only preview API I/O is controlled; all menu roots, terminal handlers and theme styles are real.
const identity = (window as any).identityMenu
const inputs: unknown[] = [], gestures: unknown[] = []
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
  select() { terminal().select(0, 0, 'src/original.txt'.length) },
  clearInputs() { inputs.length = 0; gestures.length = 0 },
  facts() { return { ...identity.facts(), terminal: identity.terminal(), inputs: [...inputs], gestures: [...gestures],
    selected: terminal().getSelection(), mouseTrackingMode: terminal().modes.mouseTrackingMode } }
} })
