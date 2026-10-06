import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRunAttachment, AgentMuxAgentWriteInput, AgentMuxRunRef } from '@agentmux/core'
import { MobileTerminalViewer } from '../src/terminal/MobileTerminalViewer'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface } from '../src/recovery/device-workface'
import '../src/mobile.css'
import '@agentmux/client-ui/styles.css'

// This separate HTML entry is test-only. Product startup never receives this fixture client.
const listeners = new Set<(event: AgentMuxClientEvent) => void>()
const calls: Array<{ method: string; args: unknown[] }> = [], forbidden: string[] = [], copies: string[] = [], notifications: string[] = []
const inputReceipts: Array<{ input: AgentMuxAgentWriteInput; receipt: { runId: string; appliedByteRange: { startByte: number; endByte: number }; acceptedThroughByte: number } }> = []
const raw: number[] = [], written: Uint8Array[] = [], held: Array<() => void> = []
const encoder = new TextEncoder()
let delayCallbacks = false, resizeRevision = 0, cols = 80, rows = 24, parsedWrites = 0
let terminal: Terminal | null = null
let inputCursor = 0, loseInputReceipt = false, explicitControlGesture = false
const originalOpen = Terminal.prototype.open, originalWrite = Terminal.prototype.write
Terminal.prototype.open = function (...args) { terminal = this; return originalOpen.apply(this, args) }
Terminal.prototype.write = function (data, callback) {
  if (data instanceof Uint8Array) written.push(data.slice())
  return originalWrite.call(this, data, () => { parsedWrites += 1; if (delayCallbacks) held.push(() => callback?.()); else callback?.() })
}
Object.defineProperty(window, 'Notification', { configurable: true, value: class { constructor() { notifications.push('Notification'); throw new Error('Unexpected terminal notification') } } })
const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: 'private-fixture-session', providerId: 'codex', executorId: 'local', hostId: 'private-fixture-host',
  workspacePath: fixturePath("private/fixture"), run: { runId: 'private-fixture-run' }, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1) }
const attachment = (): AgentMuxRunAttachment => ({ run: { ...session.run, nativeService: null, kind: 'agent', agentSessionId: session.agentSessionId, providerId: 'codex', executorId: 'local', workspacePath: session.workspacePath,
  pid: 1, state: 'running', cols, rows, observedAt: _reshape_fixtureEpoch(0, 0, 1), latestOutputBytes: raw.length, acceptedInputBytes: 0 }, replay: [], gap: null, resizeRevision,
  terminal: { type: 'basic-vt', checkpoint: { runId: session.run.runId, throughByte: raw.length, resizeRevision, size: { cols, rows },
    restoreSize: { cols, rows }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 },
    restoreBytes: raw.length ? new Uint8Array(raw) : encoder.encode('\x1b[0m'), resizes: [] } })
const finite = {
  // Optional public read transport is absent in this bounded terminal SDK fixture.
  subscribeRpc: undefined as AgentMuxHostedClient['subscribeRpc'],
  forwardRpc: undefined as AgentMuxHostedClient['forwardRpc'],
  // This bounded SDK fixture has no observed public RPC owner; diagnostics remain unknown.
  runtimeOwnerIdentity() { return null },
  runtimeIdentity() { return { hostId: 'local', instanceId: 'private-fixture-runtime', buildIdentity: 'fixture', protocolVersion: 1, processId: null } },
  agentSession(id: string) { if (id !== session.agentSessionId) throw new Error('Fixture Session mismatch'); return session },
  agentSessions() { return [session] },
  async sessionHistoryPage() { return { agentSessionId: session.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'private-native' }, items: [], nextCursor: null } },
  async sessionTimeline() { return { agentSessionId: session.agentSessionId, revision: 0, items: [] } },
  async observeSessionHistory() { return { source: { providerId: 'codex', nativeSessionId: 'private-native' }, dispose() {} } },
  onEvent(listener: (event: AgentMuxClientEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
  async reattachAgent(...args: unknown[]) { calls.push({ method: 'reattachAgent', args }); return { session, attachment: attachment() } },
  async readRunReplay(...args: unknown[]) { calls.push({ method: 'readRunReplay', args }); return attachment() },
  async releaseRunAttachment(...args: unknown[]) { calls.push({ method: 'releaseRunAttachment', args }) },
  async writeAgent(input: AgentMuxAgentWriteInput) {
    if (document.querySelector('.mobile-terminal')?.getAttribute('data-control') !== 'control' && !explicitControlGesture) {
      forbidden.push('writeAgent'); throw new Error('Passive mounted terminal submitted Input')
    }
    calls.push({ method: 'writeAgent', args: [input] })
    if (input.expectedRun.runId !== session.run.runId) throw new Error('Fixture current Run mismatch')
    const startByte = inputCursor
    inputCursor += typeof input.data === 'string' ? encoder.encode(input.data).length : input.data.length
    if (loseInputReceipt) throw new Error('Original input may have applied; fixture reply was lost')
    const receipt = { runId: session.run.runId, appliedByteRange: { startByte, endByte: inputCursor }, acceptedThroughByte: inputCursor }
    inputReceipts.push({ input, receipt })
    return receipt
  },
  async resizeAgent(id: string, run: AgentMuxRunRef, nextCols: number, nextRows: number) {
    if (document.querySelector('.mobile-terminal')?.getAttribute('data-control') !== 'control') {
      forbidden.push('resizeAgent'); throw new Error('Passive mounted terminal changed PTY size')
    }
    calls.push({ method: 'resizeAgent', args: [id, run, nextCols, nextRows] })
    if (id !== session.agentSessionId || run.runId !== session.run.runId) throw new Error('Fixture exact Run mismatch')
    cols = nextCols; rows = nextRows; resizeRevision += 1
    emit({ type: 'terminal-resized', agentSessionId: id, run, cols, rows, throughByte: raw.length, resizeRevision })
    return { ...run, cols, rows }
  }
}
// Any accidental control call is observed and fails immediately, including terminal queries.
const client = new Proxy(finite, { get(target, key: keyof typeof finite) {
  if (key in target) return target[key]
  return (..._args: unknown[]) => { forbidden.push(String(key)); throw new Error(`Passive viewer called ${String(key)}`) }
} }) as unknown as AgentMuxHostedClient
let root = createRoot(document.getElementById('root')!)
const platform = createBrowserPlatform({ clipboard: { async writeText(text) { copies.push(text) } } })
const connection = { state: 'connected' as const, message: 'Private test fixture; authenticated Host and native devices are not exercised.' }
const render = (visible = true, online = true, port = client, selectedId = session.agentSessionId) => root.render(<div className="mobile-app"><header className="mobile-header"><div className="mobile-brand">AgentMux</div><span>私有终端测试</span></header><div className="mobile-context">fixture / 原会话输出</div><main className="mobile-terminal-panel" hidden={!visible}>
  <MobileTerminalViewer client={online ? port : null} agentSessionId={selectedId} connection={online ? connection : { state: 'disconnected', message: '输出连接中断；原画面保留，Run 状态未知。' }} platform={platform} visible={visible} />
  </main><aside className="mobile-service-notice">私有 fixture · 只验证真实 xterm 客户端行为</aside><nav className="mobile-navigation"><button>对话</button><button>会话</button><button aria-current="page">终端</button><button>连接</button></nav></div>)
function emit(event: AgentMuxClientEvent) { for (const listener of listeners) listener(event) }
function output(dataBytes: Uint8Array, startByte = raw.length, runId = session.run.runId) {
  if (runId === session.run.runId) {
    const suffix = dataBytes.subarray(Math.max(0, raw.length - startByte))
    for (const byte of suffix) raw.push(byte)
  }
  emit({ type: 'terminal-output', run: { runId }, agentSessionId: session.agentSessionId, dataBytes, data: 'semantic observation must not be parsed',
    evidence: { source: 'terminal-output', observedAt: _reshape_fixtureEpoch(0, 0, 1), outputByteRange: { startByte, endByte: startByte + dataBytes.length } } })
}
async function until(test: () => boolean, label: string) {
  const start = performance.now()
  while (!test()) { if (performance.now() - start > 4_000) throw new Error(`AssertionError: Fixture deadline: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)) }
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`AssertionError: ${message}`) }
function text() { const buffer = terminal!.buffer.active; return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true)).join('\n') }

/** Exercise the same visible reading Dialog that now owns secondary user actions. */
async function clickReadingDetail(label: string) {
  document.querySelector<HTMLButtonElement>('[aria-label="终端阅读与状态"]')!.click()
  await until(() => document.querySelector('[role="dialog"]') !== null, 'visible terminal reading Dialog')
  const action = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent?.trim() === label)
  assert(action, `Actual reading Dialog action ${label}`)
  action.click()
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  document.querySelector<HTMLButtonElement>('[aria-label="关闭终端阅读"]')!.click()
  await until(() => document.querySelector('[role="dialog"]') === null, 'reading Dialog explicitly closed')
}
const originalInputAcknowledged = () => localStorage.getItem(`agentmux-mobile-terminal-intent-v1:${session.agentSessionId}`) === null


export async function runBrowserProof() {
  const cases: Array<{ name: string; facts: unknown }> = []
  render(); await until(() => terminal !== null && document.querySelector('[data-reading="reading"]') !== null, 'actual terminal mounted')
  assert(document.querySelector('.xterm-screen') !== null && terminal!.options.disableStdin === true, 'Actual maintained xterm is passive')
  cases.push({ name: 'actual-xterm-mounted', facts: { cols: terminal!.cols, rows: terminal!.rows, disableStdin: terminal!.options.disableStdin } })
  const word = encoder.encode('你好'); delayCallbacks = true; output(word.subarray(0, 2))
  await until(() => held.length === 1, 'actual parser callback held')
  output(word.subarray(0, 4), 0); output(word.subarray(4), 4)
  assert(!text().includes('你好'), 'Queued suffix must wait for in-flight parser callback')
  delayCallbacks = false; for (const release of held.splice(0)) release()
  await until(() => text().includes('你好'), 'split UTF-8 raw parse')
  assert(text().split('你好').length === 2 && !text().includes('semantic observation'), 'Raw UTF-8 and overlap parsed exactly once')
  cases.push({ name: 'raw-utf8-overlap-parser-callback', facts: { firstWrites: written.slice(0, 3).map(value => [...value]), text: text().trim() } })
  const before = written.length
  for (let index = 0; index < 1_000; index++) output(encoder.encode('unrelated'), 0, 'other-private-run')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert(written.length === before && !text().includes('unrelated'), 'Unrelated Run does no parser work')
  cases.push({ name: 'unrelated-run-zero-parser-work', facts: { events: 1_000, before, after: written.length } })
  const queryWrites = parsedWrites
  output(encoder.encode('\x1b]52;c;Zml4dHVyZS1zZWNyZXQ=\x07\x07\x1b[6n\x1b[c'))
  await until(() => parsedWrites > queryWrites, 'OSC/BEL/query bytes parsed')
  assert(copies.length === 0 && forbidden.length === 0 && notifications.length === 0, 'Output cannot invoke clipboard, notifications or remote query replies')
  const input = document.querySelector('.xterm-helper-textarea')!
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })); input.dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', bubbles: true }))
  input.dispatchEvent(new Event('paste', { bubbles: true }))
  assert(forbidden.length === 0, 'Input events never reach a Runtime method')
  cases.push({ name: 'no-control-output-side-effects', facts: { forbidden: [...forbidden], automaticClipboardWrites: copies.length, notifications: [...notifications] } })
  resizeRevision += 1; cols = 52; rows = 18
  emit({ type: 'terminal-resized', run: session.run, agentSessionId: session.agentSessionId, cols, rows, throughByte: raw.length, resizeRevision })
  await until(() => terminal!.cols === cols && terminal!.rows === rows, 'authoritative local geometry')
  document.getElementById('root')!.style.width = '320px'; window.dispatchEvent(new Event('resize'))
  assert(terminal!.cols === 52 && forbidden.length === 0, 'Viewport does not negotiate remote PTY size')
  cases.push({ name: 'owner-geometry-view-only', facts: { cols: terminal!.cols, rows: terminal!.rows, forbidden: [...forbidden] } })
  terminal!.select(0, 0, 2)
  const selected = terminal!.getSelection(); assert(selected.length > 0, 'Real xterm selection is nonempty')
  await clickReadingDetail('复制选中文字')
  await until(() => copies.length === 1, 'explicit OS adapter copy')
  assert(copies[0] === selected, 'Explicit copy uses exact selection')
  cases.push({ name: 'explicit-selection-copy', facts: { selected, copies: [...copies] } })
  output(encoder.encode('\r\n' + Array.from({ length: 160 }, (_, index) => `history ${index}`).join('\r\n') + '\r\n'))
  await until(() => terminal!.buffer.active.baseY > 100, 'normal buffer retained history')
  terminal!.scrollToLine(0); const readingLine = terminal!.buffer.active.viewportY
  output(encoder.encode('new active output\r\n')); await until(() => text().includes('new active output'), 'new active bytes')
  assert(terminal!.buffer.active.viewportY === readingLine, 'Active bytes preserve an upward reading position')
  cases.push({ name: 'continuous-reading-during-output', facts: { readingLine, after: terminal!.buffer.active.viewportY, retainedLines: terminal!.buffer.active.length } })
  const screenBefore = text(); render(true, false)
  await until(() => calls.filter(value => value.method === 'releaseRunAttachment').length === 1, 'offline reader release')
  await until(() => document.querySelector('.mobile-terminal-notice')!.textContent!.includes('Run 状态未知'), 'offline service notice committed')
  assert(text() === screenBefore, `Unknown connection retains the original screen (${screenBefore.length}→${text().length}; before tail ${JSON.stringify(screenBefore.slice(-100))}; after tail ${JSON.stringify(text().slice(-100))})`)
  assert(document.body.textContent!.includes('Run 状态未知'), 'Offline notice remains visible after copying')
  render(true, true); await until(() => calls.filter(value => value.method === 'reattachAgent').length === 2 && document.querySelector('[data-reading="reading"]') !== null, 'same original Run restored')
  cases.push({ name: 'offline-projection-original-reference', facts: { originalSession: session.agentSessionId, originalRun: session.run.runId, screenRetained: true } })
  render(false); await until(() => calls.filter(value => value.method === 'releaseRunAttachment').length === 2, 'hidden view lease release')
  render(true); await until(() => calls.filter(value => value.method === 'reattachAgent').length === 3 && document.querySelector('[data-reading="reading"]') !== null, 'original Run visible again')
  root.unmount(); await until(() => calls.filter(value => value.method === 'releaseRunAttachment').length === 3, 'unmount own reader')
  assert(forbidden.length === 0 && listeners.size === 0, 'Closing a viewer releases only its own observer')
  assert(calls.filter(value => value.method === 'releaseRunAttachment').map(value => JSON.stringify(value.args)).join('|') === Array(3).fill('[{"runId":"private-fixture-run"}]').join('|'), 'Exact original Run lease released')
  cases.push({ name: 'hide-close-own-observer-only', facts: { calls, remainingListeners: listeners.size, forbidden } })
  localStorage.setItem('agentmux-mobile-workface-v1', JSON.stringify({ ...emptyDeviceWorkface(), selectedSessionId: session.agentSessionId, hostUrl: '', panel: 'terminal' }))
  root = createRoot(document.getElementById('root')!)
  root.render(<MobileApp client={client} connection={connection} platform={platform} />)
  await until(() => document.querySelector('.mobile-terminal-panel .xterm-screen') !== null && calls.filter(value => value.method === 'reattachAgent').length === 4, 'actual MobileApp terminal panel consumes the viewer')
  assert(document.querySelector('.mobile-terminal-panel')!.hasAttribute('hidden') === false && document.querySelector('[aria-current="page"]')!.textContent === '终端', 'Actual app navigation mounts the real viewer')
  const canvasElement = document.querySelector('.xterm-screen')
  document.querySelector<HTMLButtonElement>('.mobile-navigation button')!.click()
  await until(() => calls.filter(value => value.method === 'releaseRunAttachment').length === 4, 'actual navigation releases its reader')
  assert(document.querySelector('.xterm-screen') === canvasElement, 'Navigation retains the existing local canvas')
  root.unmount(); await until(() => listeners.size === 0, 'actual app observation cleanup')
  assert(forbidden.length === 0, 'Actual root caller remains passive')
  cases.push({ name: 'actual-mobile-app-terminal-navigation', facts: { originalSession: session.agentSessionId, attachCalls: 4, releaseCalls: 4, remainingListeners: listeners.size, forbidden: [...forbidden] } })
  return { schema: 'agentmux.mobile-terminal-browser-preparation.v1', passed: true, cases, limitations: ['Real Chromium/xterm and public SDK-shaped private fixture only; no authenticated Host, native device or actual Run assertion.'] }
}

export function renderVisualFixture() {
  raw.length = 0; written.length = 0; cols = 80; rows = 24; resizeRevision = 0
  for (const byte of encoder.encode('\x1b[32m~/workspace\x1b[0m  \x1b[90mAgent session\x1b[0m\r\n\r\n$ pnpm test\r\n\r\n \x1b[32m✓\x1b[0m  Preserve the original session\r\n \x1b[32m✓\x1b[0m  Read ordered Runtime bytes\r\n \x1b[32m✓\x1b[0m  Release only this viewer\r\n\r\n\x1b[32m3 passed\x1b[0m  ·  waiting for next output\r\n\r\n只读输出 · 输入仍由 Mac 管理\r\n')) raw.push(byte)
  localStorage.setItem('agentmux-mobile-workface-v1', JSON.stringify({ ...emptyDeviceWorkface(), selectedSessionId: session.agentSessionId, hostUrl: '', panel: 'terminal' }))
  root.render(<MobileApp client={client} connection={connection} platform={platform} />)
}

/** Bounded visual QA uses the real MobileApp/Viewer; only its semantic SDK is controlled. */
export async function prepareTerminalSurfaceVisual(mode: 'normal' | 'alternate' | 'unknown', nextCols = 80, nextRows = 24) {
  renderVisualFixture()
  await until(() => terminal !== null && document.querySelector('[data-reading="reading"]') !== null, 'mounted production MobileApp terminal')
  cols = nextCols; rows = nextRows; resizeRevision += 1
  emit({ type: 'terminal-resized', agentSessionId: session.agentSessionId, run: session.run, cols, rows, throughByte: raw.length, resizeRevision })
  await until(() => terminal!.cols === cols && terminal!.rows === rows, 'authoritative SDK geometry for visual QA')
  if (mode === 'alternate') {
    output(encoder.encode('\x1b[?1049h\x1b[2J\x1b[H' + Array.from({length:rows}, (_, i) => `\x1b[${i + 1};1H\x1b[${i % 2 ? 36 : 32}m原始网格 ${i + 1} · ANSI / 中文 / 🚀\x1b[0m` + '·'.repeat(Math.max(0, cols - 35))).join('') + `\x1b[${rows};${Math.max(1, cols - 6)}H\x1b[33m最右端Z\x1b[0m`))
  }
  if (mode === 'unknown') {
    document.querySelector<HTMLButtonElement>('.mobile-terminal-mode')!.click()
    await until(() => terminal!.options.disableStdin === false, 'explicit visual control')
    loseInputReceipt = true
    terminal!.input('original uncertain fixture', true)
    terminal!.input('retained unsent fixture', true)
    await until(() => document.querySelector('.mobile-terminal-reading-trigger')?.getAttribute('data-notice') === 'true', 'unknown original operation remains discoverable')
  }
  return { fixture: true, mode, agentSessionId: session.agentSessionId, runId: session.run.runId, cols, rows, calls, forbidden }
}

export async function runControlBrowserProof() {
  const cases: Array<{ name: string; facts: unknown }> = []
  const writes = () => calls.filter(value => value.method === 'writeAgent')
  const sizes = () => calls.filter(value => value.method === 'resizeAgent')
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)
    assert(found, `Actual mounted button ${label}`); return found!
  }
  render(); await until(() => terminal !== null && document.querySelector('[data-reading="reading"]') !== null, 'reader mounted')
  assert(terminal!.options.disableStdin === true && terminal!.textarea?.readOnly === true, 'The initial real xterm remains in watching mode')
  terminal!.input('watch must not write', true); terminal!.input('\x1b[1;1R', false)
  assert(writes().length === 0 && sizes().length === 0, 'Watching has no Input or size side effect')
  button('控制终端').click()
  await until(() => terminal!.options.disableStdin === false && terminal!.textarea?.readOnly === false, 'explicit native input activated')
  assert(document.activeElement === terminal!.textarea, 'Only the explicit control gesture focuses the native terminal textarea')
  terminal!.input('你好', true)
  terminal!.input('\x1b[1;1R', false); terminal!.input('\x1b[?1;2c', false)
  await until(() => writes().length === 1 && inputReceipts.some(value => value.input.data === '你好' && value.receipt.runId === session.run.runId) && originalInputAcknowledged(), 'native UTF-8 receipt')
  const input = writes()[0]!.args[0] as AgentMuxAgentWriteInput
  assert(input.data === '你好' && input.source === 'user' && input.expectedRun.runId === session.run.runId && input.agentSessionId === session.agentSessionId,
    'Exact original SDK Input tuple carries true Unicode, with no fabricated operation ID')
  assert(Object.keys(input).sort().join(',') === 'agentSessionId,data,expectedRun,source', 'Raw API arguments remain the original four fields')
  document.querySelector<HTMLButtonElement>('[aria-label="终端 Esc"]')!.click()
  await until(() => writes().length === 2, 'explicit touch function key applied')
  assert((writes()[1]!.args[0] as AgentMuxAgentWriteInput).data === '\x1b', 'Touch function key shares the original user input source')
  output(encoder.encode('\x1b[6n\x1b[c'))
  await until(() => parsedWrites >= 2, 'active output query parse')
  assert(writes().length === 2 && sizes().length === 0 && copies.length === 0, 'Even control mode cannot forward parser replies or automatic clipboard')
  cases.push({ name: 'explicit-actual-xterm-user-input-only', facts: { input, writes: writes().length, sizeCalls: sizes().length } })
  button('PTY 尺寸').click()
  await until(() => document.querySelector('[aria-label="PTY 列数"]') !== null, 'explicit size form mounted')
  const column = document.querySelector<HTMLInputElement>('[aria-label="PTY 列数"]')!, row = document.querySelector<HTMLInputElement>('[aria-label="PTY 行数"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(column, '52'); column.dispatchEvent(new Event('input', { bubbles: true }))
  setter.call(row, '18'); row.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  document.querySelector('form.mobile-terminal-size')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await until(() => sizes().length === 1 && terminal!.cols === 52 && terminal!.rows === 18, 'manual authoritative size propagated')
  assert(JSON.stringify(sizes()[0]!.args) === JSON.stringify([session.agentSessionId, session.run, 52, 18]), 'Only the explicit form sends original size tuple')
  window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('orientationchange'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert(sizes().length === 1, 'Window/rotation cannot resize remote PTY')
  cases.push({ name: 'manual-original-size-no-viewport-policy', facts: sizes()[0] })
  loseInputReceipt = true; terminal!.input('uncertain original', true)
  await until(() => terminal!.options.disableStdin === true && document.querySelector('.mobile-terminal-notice')!.textContent!.includes('回执未确认'), 'unknown receipt remains visible')
  const count = writes().length
  button('回到观看').click()
  render(false); await until(() => calls.some(value => value.method === 'releaseRunAttachment'), 'hidden viewer releases own observation')
  render(true); await until(() => document.querySelector('[data-reading="reading"]') !== null, 'same canvas resumes')
  assert(writes().length === count && terminal!.options.disableStdin === true, 'Foreground/reconnect never repeats uncertain bytes or opens keyboard')
  const saved = localStorage.getItem(`agentmux-mobile-terminal-intent-v1:${session.agentSessionId}`)!
  assert(saved && !saved.includes('uncertain original'), 'Restart guard persists only unresolved metadata, no terminal log or credential')
  root.unmount(); root = createRoot(document.getElementById('root')!); terminal = null
  render(); await until(() => terminal !== null && document.querySelector('[data-reading="reading"]') !== null, 'new actual component instance')
  assert(button('控制终端').disabled === true && terminal!.options.disableStdin === true && writes().length === count, 'Cold component admission is unknown and never writes')
  await clickReadingDetail('已在原会话核对，继续新输入')
  await until(() => button('控制终端').disabled === false, 'explicit review releases old local guard')
  loseInputReceipt = false; button('控制终端').click()
  await until(() => document.querySelector('.mobile-terminal')!.getAttribute('data-control') === 'control', 'explicit new control mode committed')
  terminal!.input('new intent only', true)
  await until(() => writes().length === count + 1, 'new explicit original Run input')
  assert((writes().at(-1)!.args[0] as AgentMuxAgentWriteInput).data === 'new intent only', 'Uncertain old bytes were not inserted again')
  cases.push({ name: 'unknown-receipt-native-focus-cold-restore', facts: { writes: writes().map(value => (value.args[0] as AgentMuxAgentWriteInput).data), saved: JSON.parse(saved) } })
  root.unmount(); await until(() => listeners.size === 0, 'only own observers disposed')
  return { passed: true, cases, limitations: ['Real Chromium and original maintained xterm; SDK port is controlled. Actual TLS/Host/two-client Input and physical phone acceptance are independent.'] }
}

/** The actual same-page Viewer lifecycle, including original xterm listeners and focus. */
export async function runRebindBrowserProof() {
  root.unmount(); await until(() => listeners.size === 0, 'previous own observers closed')
  root = createRoot(document.getElementById('root')!); terminal = null
  const cases: Array<{ name: string; facts: unknown }> = []
  const writes = () => calls.filter(value => value.method === 'writeAgent')
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)
    assert(found, `Actual mounted button ${label}`); return found!
  }
  const port = (overrides: Partial<typeof finite> = {}) => new Proxy({ ...finite, ...overrides }, { get(target, key: keyof typeof finite) {
    if (key in target) return target[key]
    return () => { forbidden.push(String(key)); throw new Error(`Fixture unapproved method ${String(key)}`) }
  } }) as unknown as AgentMuxHostedClient
  const clickControl = async () => {
    // The actual explicit gesture authorizes retained intent synchronously, before
    // React commits its visible mode. Rebind/foreground alone never gets this fact.
    explicitControlGesture = true
    try { button('控制终端').click() } finally { explicitControlGesture = false }
    await until(() => terminal!.options.disableStdin === false && document.querySelector('[data-control="control"]') !== null, 'explicit real xterm control')
  }
  const rebind = async (next: AgentMuxHostedClient, selectedId = session.agentSessionId) => {
    const count = calls.filter(value => value.method === 'reattachAgent').length
    render(true, true, next, selectedId)
    await until(() => calls.filter(value => value.method === 'reattachAgent').length > count
      && document.querySelector(`[data-agent-session-id="${selectedId}"][data-control="watch"]`) !== null
      && terminal!.options.disableStdin === true, 'actual selected owner rebound in watching mode')
  }
  render(); await until(() => terminal !== null && document.querySelector('[data-reading="reading"]') !== null, 'original viewer mounted')
  assert(terminal!.options.disableStdin === true && terminal!.textarea?.readOnly === true, 'New mounted canvas admits no keyboard before its explicit owner gesture')
  // A preceding failed controlled run can leave its real metadata guard. Admit the
  // new test intent through the product's explicit review gesture, never storage deletion.
  if (button('控制终端').disabled) {
    await clickReadingDetail('已在原会话核对，继续新输入')
    await until(() => !button('控制终端').disabled, 'prior controlled fixture explicitly reviewed')
  }
  await clickControl()
  loseInputReceipt = true; terminal!.input('original unknown', true); terminal!.input('same-page suffix', true)
  await until(() => terminal!.options.disableStdin === true && document.querySelector('.mobile-terminal-notice')!.textContent!.includes('回执未确认'), 'unknown original dispatch')
  const originalWrites = writes().map(value => (value.args[0] as AgentMuxAgentWriteInput).data), originalCanvas = terminal
  assert(originalWrites.length === 1 && originalWrites[0] === 'original unknown', 'Only the first original operation was invoked')
  const replacement = port()
  await rebind(replacement)
  assert(terminal === originalCanvas && terminal!.options.disableStdin && button('控制终端').disabled, 'SDK replacement keeps the canvas and returns to watch with unknown intent')
  await clickReadingDetail('复制未发送输入'); await until(() => copies.at(-1) === 'same-page suffix', 'original never-called suffix remains copyable')
  assert(writes().length === 1, 'Replacement cannot replay an uncertain operation or its suffix')
  const stored = localStorage.getItem(`agentmux-mobile-terminal-intent-v1:${session.agentSessionId}`)!
  assert(stored && !stored.includes('original unknown') && !stored.includes('suffix'), 'Rebinding never persists terminal payload')
  await clickReadingDetail('已在原会话核对，继续新输入')
  await until(() => !button('控制终端').disabled, 'original unknown intent explicitly reviewed')
  loseInputReceipt = false; await clickControl()
  await until(() => writes().length === 2 && inputReceipts.some(value => value.input.data === 'same-page suffix' && value.receipt.runId === session.run.runId) && originalInputAcknowledged(), 'only retained suffix receives its original ACK')
  assert(JSON.stringify(writes().map(value => (value.args[0] as AgentMuxAgentWriteInput).data)) === JSON.stringify(['original unknown', 'same-page suffix']), 'Original unknown bytes never re-enter the queue')
  cases.push({ name: 'same-page-sdk-replacement-keeps-original-unknown-and-suffix', facts: { writes: writes().map(value => value.args[0]), retainedCanvas: terminal === originalCanvas, saved: JSON.parse(stored) } })

  loseInputReceipt = true; terminal!.input('second unknown', true); terminal!.input('original owner only', true)
  await until(() => terminal!.options.disableStdin === true, 'second unknown dispatch')
  const count = writes().length
  await rebind(port({ runtimeIdentity: () => ({ ...finite.runtimeIdentity(), instanceId: 'different-Mac-runtime' }) }))
  await clickReadingDetail('已在原会话核对，继续新输入'); await until(() => !button('控制终端').disabled, 'explicit review on changed owner')
  document.querySelector<HTMLButtonElement>('[aria-label="终端阅读与状态"]')!.focus(); button('控制终端').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert(terminal!.options.disableStdin && document.activeElement !== terminal!.textarea && writes().length === count, 'Same Session/Run IDs on another Mac cannot receive input or focus')
  const originalRun = session.run
  session.run = { runId: 'Core-confirmed-new-run' }; await rebind(port()); button('控制终端').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert(terminal!.options.disableStdin && writes().length === count, 'Original queued bytes cannot cross a confirmed Run replacement')
  await clickReadingDetail('复制未发送输入'); await until(() => copies.at(-1) === 'original owner only', 'wrong owner retained suffix')
  session.run = originalRun; await rebind(port()); loseInputReceipt = false; await clickControl()
  await until(() => writes().length === count + 1, 'only original owner can receive its uninvoked suffix after explicit control')
  assert((writes().at(-1)!.args[0] as AgentMuxAgentWriteInput).data === 'original owner only', 'Retained suffix was not discarded or misdirected')
  cases.push({ name: 'same-page-queue-isolated-from-another-Mac-and-replacement-Run', facts: { count, finalWrite: writes().at(-1) } })

  let rejectOriginal!: (reason: Error) => void
  const heldReply = new Promise<never>((_resolve, reject) => { rejectOriginal = reject })
  const heldPort = port({ async writeAgent(input) { await finite.writeAgent(input); return heldReply } })
  await rebind(heldPort); await clickControl()
  terminal!.input('late original', true); terminal!.input('Session A suffix', true)
  const otherSession = { ...session, agentSessionId: 'private-fixture-other-session', run: { runId: 'private-fixture-other-run' } }
  const other = port({ agentSession(id) { assert(id === otherSession.agentSessionId, 'Selected Session B facts'); return otherSession } })
  await rebind(other, otherSession.agentSessionId)
  await clickControl(); const beforeLate = writes().length
  rejectOriginal(new Error('Late Session A ACK remains unknown'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert(document.querySelector('[data-control="control"]') !== null && !terminal!.options.disableStdin && writes().length === beforeLate,
    'Session A late unknown result cannot mutate Session B controls or dispatch its suffix')
  await rebind(port(), session.agentSessionId)
  assert(button('控制终端').disabled, 'Original selected Session A still owns its unknown intent')
  await clickReadingDetail('复制未发送输入'); await until(() => copies.at(-1) === 'Session A suffix', 'selected Session A retained its own suffix')
  assert(writes().length === beforeLate && terminal!.options.disableStdin, 'Returning to Session A never repeats its unknown input')
  cases.push({ name: 'late-previous-selected-session-ACK-has-no-current-session-effects', facts: { previousSession: session.agentSessionId, selectedSession: otherSession.agentSessionId, beforeLate, writes: writes().length, copied: copies.at(-1) } })
  await clickReadingDetail('已在原会话核对，继续新输入'); await clickReadingDetail('放弃未发送输入')
  root.unmount(); await until(() => listeners.size === 0, 'same-page own observers cleanup')
  assert(forbidden.length === 0, 'Rebind uses only the original finite SDK facts and methods')
  return { passed: true, cases, limitations: ['Actual mounted Chromium/xterm lifecycle with controlled semantic SDK ports; no actual phone, native trust, Host handoff or network performance claim.'] }
}

export async function renderControlVisualFixture(mode: 'watch' | 'control' | 'unknown' | 'size' = 'watch') {
  renderVisualFixture()
  await until(() => terminal !== null && document.querySelector('[data-reading="reading"]') !== null, 'actual visual terminal')
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)!
  if (mode !== 'watch') { button('控制终端').click(); await until(() => terminal!.options.disableStdin === false, 'explicit visual control') }
  if (mode === 'size') { button('PTY 尺寸').click(); await until(() => document.querySelector('.mobile-terminal-size') !== null, 'manual size form') }
  if (mode === 'unknown') {
    loseInputReceipt = true; terminal!.input('original uncertain fixture', true)
    await until(() => document.querySelector('.mobile-terminal-notice')!.textContent!.includes('回执未确认'), 'persistent unknown notice')
  }
  return { mode, runId: session.run.runId, cols: terminal!.cols, rows: terminal!.rows, fixture: true }
}

export function probeFacts() { return { calls, inputReceipts, forbidden, copies, notifications, parsedWrites, listeners: listeners.size } }


/** Actual maintained xterm, retained Viewer and original controller input bytes. */
export async function runDirectionalIconProof() {
  if (!document.querySelector('[data-control="control"]')) await renderControlVisualFixture('control')
  const canvas = terminal
  const before = calls.filter(call => call.method === 'writeAgent').length
  const directions = [['↑', 'control.key-up', '\x1b[A'], ['↓', 'control.key-down', '\x1b[B'], ['←', 'control.key-left', '\x1b[D'], ['→', 'control.key-right', '\x1b[C']] as const
  for (const [index, [label, icon, data]] of directions.entries()) {
    const key = document.querySelector<HTMLButtonElement>(`[aria-label="终端 ${label}"]`)!
    assert(key && key.querySelector(`[data-semantic-icon="${icon}"]`), 'Original directional key must have its product semantic drawing')
    key.click()
    await until(() => calls.filter(call => call.method === 'writeAgent').length === before + index + 1 && inputReceipts.some(value => value.input.data === data && value.receipt.runId === session.run.runId) && originalInputAcknowledged(), 'original directional byte receipt')
    const sent = calls.filter(call => call.method === 'writeAgent').at(-1)!.args[0] as AgentMuxAgentWriteInput
    assert(sent.data === data && sent.agentSessionId === session.agentSessionId && sent.expectedRun.runId === session.run.runId && sent.source === 'user', 'Drawing change preserves the original key bytes and Run target')
  }
  assert(terminal === canvas, 'Directional drawing never remounts the original native canvas')
  return { directions: directions.map(([label, icon, data]) => ({ label, icon, bytes: [...encoder.encode(data)] })), writes: calls.filter(call => call.method === 'writeAgent').slice(before), retainedNativeCanvas: terminal === canvas }
}

/** Private QA supplies the original Host read lease; product entry never imports this module. */
export function installAppearanceReader(reader: NonNullable<AgentMuxHostedClient['subscribeRpc']>) { finite.subscribeRpc = reader }
export async function seedPaletteReadingProof() {
  const header = '\x1b[0mPrivate native ANSI palette · 原工作面\r\n';
  const swatches = Array.from({length:16},(_,i)=>`\x1b[${i<8?30+i:90+i-8}m${String(i).padStart(2,'0')} 色 \x1b[0m${i%4===3?'\r\n':''}`).join('');
  output(encoder.encode(header+swatches+'\r\n\x1b[31mDanger · 失败\x1b[0m  \x1b[33mWarning · 待确认\x1b[0m\r\n\x1b[32mSuccess · 已完成\x1b[0m  中文与 Unicode 保留\r\n'+Array.from({length:65},(_,i)=>`Original reading row ${i+1} · 内容不随颜色改变\r\n`).join('')));
  await until(()=>text().includes('Original reading row 65'),'real private replay bytes');
  terminal!.scrollToLine(10);terminal!.select(0,12,24);
  return mobilePaletteFacts();
}
export function mobilePaletteFacts() { return {palette:terminal!.options.theme,viewport:terminal!.buffer.active.viewportY,base:terminal!.buffer.active.baseY,selection:terminal!.getSelection(),text:text(),fontSize:terminal!.options.fontSize,canvasPresent:!!document.querySelector('.xterm-screen'),attachCalls:calls.filter(c=>c.method==='reattachAgent').length,forbidden:[...forbidden]} }

export async function proveCoveredNativeInputIsPassive() {
 const before=calls.filter(call=>call.method==='writeAgent').length;terminal!.input('covered native input must remain local',true);
 await new Promise(resolve=>setTimeout(resolve,25));assert(calls.filter(call=>call.method==='writeAgent').length===before,'A covering dialog cannot preserve the prior input control intent');
 return {before,after:calls.filter(call=>call.method==='writeAgent').length,readonly:terminal!.textarea?.readOnly};
}

/** Private display references and native UI adapter flags do not admit Runtime input. */
export function renderLowFrequencyMobileProof(mote: boolean) {
 const identity=mote?{name:'Private Mote reference',project:'Private project',mote:{spaceId:'private-mote-reference'}}:null;
 localStorage.setItem('agentmux-mobile-workface-v1',JSON.stringify({...emptyDeviceWorkface(),selectedSessionId:session.agentSessionId,hostUrl:'',panel:'conversation',presentation:{primary:'focus',showSession:true,showGoalWork:false,identity,profile:null}}));
 root.render(<MobileApp native client={client} connection={{...connection,issue:'Private metadata observation unavailable. The original terminal remains usable.'}} platform={platform} focusComposer={()=>{const editor=document.querySelector<HTMLElement>('[contenteditable="true"]');editor?.focus();return !!editor}} />);
 return {referenceOnly:identity,nativeUiAdapterOnly:true,noInputAdmissionClaim:true};
}
