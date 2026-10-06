import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxClientEvent, AgentMuxRunAttachment, AgentMuxAgentWriteInput } from '@agentmux/core'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { MobileTerminalViewer } from '../src/terminal/MobileTerminalViewer'
import '../src/mobile.css'
import '@agentmux/client-ui/styles.css'

// Only the SDK transport is controlled; production Viewer, reader, control,
// input subscriptions, xterm parser/gesture/wheel encoding and CSS are real.
let terminal: Terminal | null = null, cursor = 0, accepted = 0, appPosition = 0, mounted = true
const encoder = new TextEncoder(), listeners = new Set<(event: AgentMuxClientEvent) => void>()
const calls: Array<{ method: string; args: unknown[] }> = []
const originalOpen = Terminal.prototype.open
Terminal.prototype.open = function (...args) { terminal = this; return originalOpen.apply(this, args) }
const session = { kind: 'agent', agentSessionId: 'gesture-session', hostId: 'gesture-host', providerId: 'fixture', executorId: 'fixture',
  workspacePath: fixturePath('terminal-gestures'), run: { runId: 'gesture-run' }, retiredRuns: [], createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1) } as const
const snapshot = (): AgentMuxRunAttachment => ({ run: { ...session.run, nativeService: null, kind: 'agent', agentSessionId: session.agentSessionId,
  providerId: session.providerId, executorId: session.executorId, workspacePath: session.workspacePath,
  pid: 1, state: 'running', cols: 80, rows: 24, observedAt: _tailRefreshFixtureEpoch(0, 0, 1), latestOutputBytes: cursor, acceptedInputBytes: accepted }, replay: [], gap: null,
  resizeRevision: 0, terminal: { type: 'basic-vt', checkpoint: { runId: session.run.runId, throughByte: cursor, resizeRevision: 0,
    size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 },
    restoreBytes: encoder.encode('\x1b[0m'), resizes: [] } })
function output(text: string) {
  const dataBytes = encoder.encode(text), startByte = cursor; cursor += dataBytes.length
  for (const listener of listeners) listener({ type: 'terminal-output', run: session.run, agentSessionId: session.agentSessionId, data: text, dataBytes,
    evidence: { source: 'terminal-output', observedAt: _tailRefreshFixtureEpoch(0, 0, 1), outputByteRange: { startByte, endByte: cursor } } })
}
const client = {
  runtimeIdentity: () => ({ hostId: session.hostId, instanceId: 'gesture-runtime' }), agentSession: () => session,
  onEvent(listener: (event: AgentMuxClientEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
  async reattachAgent(...args: unknown[]) { calls.push({ method: 'reattachAgent', args }); return { session, attachment: snapshot() } },
  async readRunReplay(...args: unknown[]) { calls.push({ method: 'readRunReplay', args }); return snapshot() },
  async releaseRunAttachment(...args: unknown[]) { calls.push({ method: 'releaseRunAttachment', args }) },
  async writeAgent(input: AgentMuxAgentWriteInput) {
    if (input.agentSessionId !== session.agentSessionId || input.expectedRun.runId !== session.run.runId || input.source !== 'user') throw new Error('Wrong input owner')
    calls.push({ method: 'writeAgent', args: [input] })
    const text = typeof input.data === 'string' ? input.data : new TextDecoder().decode(input.data)
    const startByte = accepted; accepted += encoder.encode(text).length
    const down = [...text.matchAll(/\x1b(?:\[|O)B|\x1b\[<65;\d+;\d+M/gu)].length
    const up = [...text.matchAll(/\x1b(?:\[|O)A|\x1b\[<64;\d+;\d+M/gu)].length
    appPosition += down - up
    if (down || up) output(`\x1b[H\x1b[2JApplication item ${appPosition}\r\nOriginal Run gesture-run`)
    return { runId: session.run.runId, appliedByteRange: { startByte, endByte: accepted }, acceptedThroughByte: accepted }
  },
  async resizeAgent(...args: unknown[]) { calls.push({ method: 'resizeAgent', args }); throw new Error('A reading gesture must not resize the PTY') }
} as unknown as AgentMuxHostedClient
const root = createRoot(document.getElementById('root')!)
const render = (visible = true) => root.render(<div className="mobile-app"><header className="mobile-header"><span /><div className="mobile-brand">AgentMux</div><span /></header>
  <div className="mobile-context">会话 / 终端</div><main className="mobile-terminal-panel" hidden={!visible}>
    <MobileTerminalViewer client={client} agentSessionId={session.agentSessionId} connection={{ state: 'connected', message: 'Connected' }}
      platform={{ copyText: async () => true } as never} visible={visible} />
  </main><nav className="mobile-navigation"><button>Goals</button><button>Topics</button><button>Mote</button><button>Focus</button><button>Space</button></nav></div>)
render()
const facts = () => {
  const canvas = document.querySelector<HTMLElement>('.mobile-terminal-canvas')!, screen = document.querySelector<HTMLElement>('.xterm-screen')!
  const buffer = terminal!.buffer.active, cellHeight = screen.getBoundingClientRect().height / terminal!.rows
  const first = buffer.viewportY + Math.floor(canvas.scrollTop / cellHeight)
  return { fontSize: terminal!.options.fontSize, cols: terminal!.cols, rows: terminal!.rows, buffer: buffer.type, baseY: buffer.baseY,
    viewportY: buffer.viewportY, selection: terminal!.getSelection(), mode: document.querySelector('.mobile-terminal')?.getAttribute('data-control'),
    firstVisibleLine: buffer.getLine(first)?.translateToString(true), appPosition, calls: [...calls], listenerCount: listeners.size,
    outer: { top: canvas.scrollTop, left: canvas.scrollLeft, width: canvas.clientWidth, height: canvas.clientHeight, scrollWidth: canvas.scrollWidth, scrollHeight: canvas.scrollHeight },
    screen: screen.getBoundingClientRect().toJSON(), canvas: canvas.getBoundingClientRect().toJSON(),
    terminalCount: document.querySelectorAll('.xterm').length, currentText: buffer.getLine(buffer.viewportY)?.translateToString(true) }
}
Object.assign(window, { terminalGestureScene: {
  ready: () => !!terminal && document.querySelector('[data-reading="reading"]') !== null,
  facts,
  seed(mode: 'normal' | 'mouse' | 'alternate' | 'alternate-keys') {
    output('\x1b[?1000l\x1b[?1006l\x1b[?1l\x1b[?1049l\x1b[2J\x1b[H')
    if (mode === 'alternate' || mode === 'alternate-keys') {
      appPosition = 0
      output('\x1b[?1049h\x1b[?1h' + (mode === 'alternate' ? '\x1b[?1000h\x1b[?1006h' : '')
        + Array.from({ length: 24 }, (_, index) => `\x1b[${index + 1};1HGrid row ${index + 1} ` + '·'.repeat(60)).join(''))
    } else {
      output(Array.from({ length: 200 }, (_, index) => `History row ${index} ` + '.'.repeat(55)).join('\r\n') + '\r\n')
      if (mode === 'mouse') output('\x1b[?1000h\x1b[?1006h')
    }
  },
  select() { terminal!.select(0, terminal!.buffer.active.viewportY, 12) },
  output: () => output('Additional live output\r\n'),
  hide: () => render(false), show: () => render(true),
  unmount() { if (mounted) root.unmount(); mounted = false },
  // Mutable counters are only fixture observation. No terminal operation is invoked here.
  clearCalls() { calls.length = 0 }
} })
