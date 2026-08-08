// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { terminalKeyEventHandler } from '../src/renderer/src/lib/terminal-shortcuts'
import { routeWindowShortcut } from '../src/renderer/src/lib/shortcut-registry'

const require = createRequire(join(process.cwd(), 'apps/desktop/package.json'))
const xtermRoot = dirname(require.resolve('@xterm/xterm/package.json'))
// Exercise the installed upstream implementation, not a handwritten copy of its algorithm.
const source = readFileSync(join(xtermRoot, 'src/browser/input/CompositionHelper.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true } }).outputText
interface Helper { compositionstart(): void; compositionupdate(event: { data: string }): void; compositionend(): void }
const exports: { CompositionHelper?: new (...services: unknown[]) => Helper } = {}
new Function('require', 'exports', compiled)((name: string) => {
  if (name.endsWith('/Services')) return new Proxy({}, { get: () => () => {} })
  if (name.endsWith('/EscapeSequences')) return { C0: { DEL: '\x7f' } }
  throw new Error(`Unexpected upstream dependency: ${name}`)
}, exports)
afterEach(() => vi.useRealTimers())
it('commits only the new Chinese text when the helper caret is moved ahead of existing text', () => {
  vi.useFakeTimers()
  const textarea = document.createElement('textarea'), view = document.createElement('div'), send = vi.fn()
  const helper = new exports.CompositionHelper!(textarea, view, { buffer: { isCursorInViewport: false } }, {}, { triggerDataEvent: send }, {})
  textarea.value = '之前的文字'; textarea.setSelectionRange(0, 0)
  helper.compositionstart(); helper.compositionupdate({ data: '新增' })
  textarea.value = '新增之前的文字'; textarea.setSelectionRange(2, 2)
  helper.compositionend(); vi.runAllTimers()
  expect(send.mock.calls.map(([text]) => text)).toEqual(['新增'])
  textarea.setSelectionRange(1, 1)
  helper.compositionstart(); helper.compositionupdate({ data: '中文' })
  textarea.value = '新中文增之前的文字'; textarea.setSelectionRange(3, 3)
  helper.compositionend(); vi.runAllTimers()
  expect(send.mock.calls.map(([text]) => text)).toEqual(['新增', '中文'])
})
it('composition keys bypass both terminal actions and global window shortcuts', () => {
  const send = vi.fn(), match = vi.fn(() => 'terminal.newline')
  const handle = terminalKeyEventHandler({ sendInput: send, matchTerminalShortcut: match, kittyKeyboardActive: () => false,
    hasSelection: () => false, readSelection: () => '', rememberSelection: vi.fn(), writeClipboard: vi.fn(), clear: vi.fn(), setSearchOpen: vi.fn() })
  for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, ...properties })
    expect(handle(event)).toBe(true)
    const globalAction = vi.fn(() => true)
    expect(routeWindowShortcut(new KeyboardEvent('keydown', { key: 'd', metaKey: true, ...properties }), true, false, { 'workbench.split.right': globalAction })).toBe(false)
    expect(globalAction).not.toHaveBeenCalled()
    expect(routeWindowShortcut(new KeyboardEvent('keydown', { key: 'd', metaKey: true }), true, false, { 'workbench.split.right': globalAction })).toBe(true)
  }
  expect(send).not.toHaveBeenCalled(); expect(match).not.toHaveBeenCalled()
})
it('each WebGL pane independently notices shared atlas changes, including a pane that was hidden', () => {
  const root = dirname(require.resolve('@xterm/addon-webgl/package.json'))
  const source = readFileSync(join(root, 'src/GlyphRenderer.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exported: { GlyphRenderer?: { prototype: { beginFrame: (this: object) => boolean } } } = {}
  new Function('require', 'exports', compiled)((name: string) => name === 'common/Lifecycle' ? { Disposable: class {} } : {}, exported)
  const beginFrame = exported.GlyphRenderer!.prototype.beginFrame
  const atlas = { pageLayoutVersion: 0 }
  const first = { _atlas: atlas, _lastSeenPageLayoutVersion: -1 }, second = { _atlas: atlas, _lastSeenPageLayoutVersion: -1 }
  expect(beginFrame.call(first)).toBe(true); expect(beginFrame.call(second)).toBe(true)
  expect(beginFrame.call(first)).toBe(false); expect(beginFrame.call(second)).toBe(false)
  atlas.pageLayoutVersion++
  expect(beginFrame.call(first)).toBe(true)
  // Rendering the first pane must not consume the invalidation owed to the other one.
  expect(beginFrame.call(first)).toBe(false)
  expect(beginFrame.call(second)).toBe(true)
})
