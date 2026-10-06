import { fixturePath as _reshape_fixturePath, fixtureEpoch as _reshape_fixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { TerminalView } from '../../../src/renderer/src/components/TerminalView'
import { mountThemeRuntime, updateThemeSelection, GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import type { SessionSnapshot, TerminalThemeId } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

const proof = { terminals: [] as import('@xterm/xterm').Terminal[], disposals: 0, attaches: 0, detaches: 0, writes: [] as string[], errors: [] as string[] }
Object.assign(window, { terminalThemeProof: proof })
window.addEventListener('error', event => proof.errors.push(event.error?.stack ?? event.message))
window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
const session = { id: 'private-theme-terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: _reshape_fixturePath("private/theme-terminal"), label: 'Private original terminal',
  createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, latestOutputBytes: 0, control: { kind: 'terminal', providerId: null, hostId: 'local', terminalSessionId: 'private-theme-terminal', run: { runId: 'private-theme-run' } } } as SessionSnapshot
const text = Array.from({ length: 360 }, (_, index) => `Original line ${String(index).padStart(3, '0')} · 中文 🙂 · retained native buffer\r\n`).join('') +
  '\x1b[31mDanger\x1b[0m · \x1b[33mWarning\x1b[0m · \x1b[32mSuccess\x1b[0m\r\n' +
  Array.from({ length: 16 }, (_, index) => `\x1b[${index < 8 ? 30 + index : 90 + index - 8}m ANSI ${String(index).padStart(2,'0')} \x1b[0m${index % 8 === 7 ? '\r\n' : ' · '}`).join('') + 'Original terminal prompt > '
const dataBytes = new TextEncoder().encode(text)
session.latestOutputBytes = dataBytes.length
// Bounded replay/input port only. The production component and real xterm own all consumer work.
Object.assign(api.sessions, {
  attach: async () => { proof.attaches++; return { attachmentId: 'private-theme-attachment', session, terminal: { type: 'basic-vt', checkpoint: { runId: session.control.run.runId, throughByte: 0, resizeRevision: 0, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: new TextEncoder().encode('\x1b[0m'), resizes: [] }, resizeRevision: 0, currentSize: { cols: 80, rows: 24 }, gap: null,
    replay: [{ type: 'data', runId: session.control.run.runId, startByte: 0, endByte: dataBytes.length, dataBytes, data: text }] } },
  detach: async () => { proof.detaches++ }, resize: async (_control: unknown, cols: number, rows: number) => ({ cols, rows }),
  acknowledge: async () => {}, redraw: async () => true, replay: async () => ({ replay: [], gap: null }),
  write: async (_control: unknown, data: string) => { proof.writes.push(data) }, onEvent: () => () => {}
})
const custom = structuredClone(GRAPHITE_THEME)
custom.id = 'custom.terminal-proof'; custom.name = 'Private terminal proof'
custom.variants.light.colors.surface0 = '#fff8ed'; custom.variants.light.colors.text = '#23364e'
custom.variants.light.colors.danger = '#ac3838'; custom.variants.dark.colors.surface0 = '#132837'
custom.icons = { 'editor.match-case': {kind:'glyph',glyph:'gem'}, 'editor.match-regexp': {kind:'glyph',glyph:'gem'}, 'editor.match-word': {kind:'glyph',glyph:'gem'} }
const customThemes = { [custom.id]: themeValue(custom) }
mountThemeRuntime(window, { appAppearance: 'light' })
useAppStore.setState({ config: { appearance: { appAppearance: 'light', terminalTheme: 'graphite' }, workspaces: [], executors: {}, hosts: [],
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }, sessions: [session] } as never)
function Fixture() {
  const themeId = useAppStore(state => state.config!.appearance.terminalTheme)
  return <main style={{ padding: 16, height: '100vh', display: 'grid', gridTemplateRows: '48px 1fr', gap: 12 }}>
    <header><strong>Original TerminalView · private native consumer</strong></header>
    <section style={{ position: 'relative', minHeight: 0 }}><TerminalView session={session} themeId={themeId} interactiveResize={false}
      linkOrigin={{ workspaceId: 'private', tabGroupId: 'private', tabId: 'private', regionId: 'private' }} /></section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
Object.assign(proof, {
  select(themeId: TerminalThemeId) { useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalTheme: themeId } } })) },
  resolve(custom: boolean, mode: 'dark' | 'light' = 'light') { updateThemeSelection(custom ? { themeId: 'custom.terminal-proof', customThemes, appAppearance: mode } : { appAppearance: mode }) },
  facts() { const terminal = proof.terminals.at(-1)!; return { count: proof.terminals.length, disposals: proof.disposals, attaches: proof.attaches, detaches: proof.detaches,
    background: terminal?.options.theme?.background, foreground: terminal?.options.theme?.foreground, red: terminal?.options.theme?.red,
    length: terminal?.buffer.active.length, baseY: terminal?.buffer.active.baseY, viewportY: terminal?.buffer.active.viewportY, cols: terminal?.cols, rows: terminal?.rows,
    selection: terminal?.getSelection(), selectionPosition: terminal?.getSelectionPosition(), first: terminal?.buffer.active.getLine(0)?.translateToString(true),
    focused: document.activeElement === terminal?.textarea, unicode: terminal?.unicode.activeVersion, writes: proof.writes.slice(), errors: proof.errors.slice() } }
})
