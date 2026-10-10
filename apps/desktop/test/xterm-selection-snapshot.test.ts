// @vitest-environment happy-dom
import { Terminal, type ISelectionSnapshot } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const terminals: Terminal[] = []
beforeEach(() => {
  // Only font measurement and layout are supplied by the DOM fixture. Selection,
  // parser, buffer and public methods are the actual browser dependency owners.
  vi.stubGlobal('OffscreenCanvas', undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    font: '', measureText: (text: string) => ({ width: text.length * 8,
      actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 })
  }) as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('xterm-char-measure-element') ? 256 : 640
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 384, width: 640, height: 384, toJSON() {}
  })
})
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function open(text = 'ABCDEFGHIJ\r\nKLMNOPQRST\r\nUVWXYZ') {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true })
  terminals.push(terminal)
  const host = document.createElement('div')
  document.body.append(host)
  terminal.open(host)
  await new Promise<void>(resolve => terminal.write(text, resolve))
  return { terminal, host }
}
function snapshot(terminal: Terminal): ISelectionSnapshot {
  const selection = terminal.getSelectionSnapshot()
  expect(selection).toBeDefined()
  return selection!
}

it.each(['resize', 'clear'] as const)('publishes the restored selection after %s notified the consumer that it was empty', async action => {
  const { terminal } = await open()
  const changed = vi.fn(() => ({ has: terminal.hasSelection(), text: terminal.getSelection() }))
  terminal.onSelectionChange(changed)
  terminal.select(1, 0, 5)
  const selected = snapshot(terminal)
  if (action === 'resize') terminal.resize(90, 17)
  else terminal.clearSelection()
  expect(changed.mock.results.at(-1)?.value).toEqual({ has: false, text: '' })
  terminal.restoreSelection(selected)
  expect(terminal.getSelection()).toBe('BCDEF')
  expect(changed.mock.results.at(-1)?.value).toEqual({ has: true, text: 'BCDEF' })
})

it('publishes changed selection text when identical endpoints switch to native column mode', async () => {
  const { terminal } = await open()
  const selected: ISelectionSnapshot = { anchor: { x: 1, y: 0 }, active: { x: 4, y: 1 }, mode: 'normal', selectAll: false }
  const changed = vi.fn(() => terminal.getSelection())
  terminal.onSelectionChange(changed)
  terminal.restoreSelection(selected)
  expect(changed.mock.results.at(-1)?.value).toBe('BCDEFGHIJ\nKLMN')
  terminal.restoreSelection({ ...selected, mode: 'column' })
  expect(terminal.getSelection()).toBe('BCD\nLMN')
  expect(changed.mock.results.at(-1)?.value).toBe('BCD\nLMN')
})

it('roundtrips native alternate-buffer metadata beyond current columns when its original cells remain retained', async () => {
  const text = Array.from({ length: 78 }, (_, i) => String.fromCharCode(65 + i % 26)).join('')
  const { terminal } = await open('\x1b[?1049h' + text)
  terminal.select(60, 0, 5)
  expect(terminal.getSelection()).toBe('IJKLM')
  terminal.resize(40, 24)
  expect(terminal.buffer.active.type).toBe('alternate')
  expect(terminal.buffer.active.getLine(0)!.length).toBe(80)
  expect(terminal.hasSelection()).toBe(true)
  const selected = snapshot(terminal), nativeText = terminal.getSelection()
  expect(selected.anchor.x).toBe(60)
  terminal.restoreSelection(selected)
  expect(snapshot(terminal)).toEqual(selected)
  expect(terminal.getSelection()).toBe(nativeText)
})

it('retains a last-row minimum span encoded beyond the buffer without inventing an additional text row', async () => {
  const text = Array.from({ length: 78 }, (_, i) => String.fromCharCode(65 + i % 26)).join('')
  const { terminal } = await open('\x1b[?1049h\x1b[24;1H' + text)
  const selected: ISelectionSnapshot = {
    anchor: { x: 60, y: 23 }, minimumEnd: { x: 65, y: 23 }, mode: 'word', selectAll: false
  }
  terminal.restoreSelection(selected)
  expect(terminal.getSelection()).toBe('IJKLM')
  terminal.resize(40, 24)
  const shrunk = snapshot(terminal), nativeText = terminal.getSelection()
  expect(shrunk.minimumEnd!.y).toBe(terminal.buffer.active.length)
  // Native cols-only resize already changes this text. Restore preserves that
  // oracle; minimumEnd encodes a span rather than claiming another text row.
  terminal.restoreSelection(shrunk)
  expect(snapshot(terminal)).toEqual(shrunk)
  expect(terminal.getSelection()).toBe(nativeText)
  terminal.resize(80, 24)
  expect(snapshot(terminal)).toEqual(selected)
  expect(terminal.getSelection()).toBe('IJKLM')
})

it.each([
  ['numeric strings', { anchor: { x: '1', y: '0' } }],
  ['null coordinates', { anchor: { x: null, y: null } }],
  ['fractional coordinates', { anchor: { x: 1.5, y: 0 } }],
  ['negative coordinates', { anchor: { x: -1, y: 0 } }],
  ['missing anchor', { anchor: undefined }],
  ['outside retained cells', { active: { x: 81, y: 0 } }],
  ['unknown mode', { mode: 'other' }],
  ['nonboolean selectAll', { selectAll: 1 }],
  ['backwards minimum range', { minimumEnd: { x: 0, y: 0 } }]
])('rejects %s before changing the existing native selection', async (_name, malformed) => {
  const { terminal } = await open()
  terminal.select(1, 0, 5)
  const selected = snapshot(terminal)
  expect(() => terminal.restoreSelection({ ...selected, ...malformed } as unknown as ISelectionSnapshot)).toThrow()
  expect(snapshot(terminal)).toEqual(selected)
  expect(terminal.getSelection()).toBe('BCDEF')
})

it('copies snapshot points both when exporting and restoring without exposing a mutable selection model', async () => {
  const { terminal } = await open()
  terminal.select(1, 0, 5)
  const exported = snapshot(terminal), expected = structuredClone(exported)
  exported.anchor.x = 7
  exported.minimumEnd!.x = 8
  expect(snapshot(terminal)).toEqual(expected)
  expect(terminal.getSelection()).toBe('BCDEF')
  terminal.clearSelection()
  terminal.restoreSelection(expected)
  expected.anchor.x = 8
  expected.minimumEnd!.x = 9
  expect(snapshot(terminal)).toEqual({ anchor: { x: 1, y: 0 }, minimumEnd: { x: 6, y: 0 }, mode: 'normal', selectAll: false })
  expect(terminal.getSelection()).toBe('BCDEF')
})

it.each([false, true])('retains an exact trailing newline and raw drag direction (reverse=%s)', async reverse => {
  const { terminal } = await open('ABC\r\nDEF\r\nGHI')
  const first = { x: 0, y: 0 }, next = { x: 0, y: 1 }
  const selected: ISelectionSnapshot = { anchor: reverse ? next : first, active: reverse ? first : next, mode: 'normal', selectAll: false }
  terminal.restoreSelection(selected)
  expect(snapshot(terminal)).toEqual(selected)
  expect(terminal.getSelection()).toBe('ABC\n')
})

it('roundtrips native select-all metadata and text', async () => {
  const { terminal } = await open()
  terminal.selectAll()
  const selected = snapshot(terminal), text = terminal.getSelection()
  expect(selected.selectAll).toBe(true)
  terminal.clearSelection()
  terminal.restoreSelection(selected)
  expect(snapshot(terminal)).toEqual(selected)
  expect(terminal.getSelection()).toBe(text)
})

it.each(['restore', 'dispose'] as const)('releases drag listeners from the exact abandoned document on %s after public reopen', async action => {
  const { terminal, host } = await open()
  terminal.select(1, 0, 5)
  const selected = snapshot(terminal)
  const added = vi.spyOn(document, 'addEventListener'), removed = vi.spyOn(document, 'removeEventListener')
  host.querySelector('.xterm-screen')!.dispatchEvent(new MouseEvent('mousedown', {
    clientX: 16, clientY: 32, button: 0, buttons: 1, detail: 1, bubbles: true, cancelable: true
  }))
  const drag = added.mock.calls.filter(([type]) => type === 'mousemove' || type === 'mouseup')
  expect(drag.map(([type]) => type).sort()).toEqual(['mousemove', 'mouseup'])
  // A defensive removal before registration cannot satisfy the later cleanup.
  removed.mockClear()
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const child = frame.contentDocument!
  child.body.append(child.adoptNode(host))
  terminal.open(host)
  expect(terminal.element!.ownerDocument).toBe(child)
  if (action === 'restore') terminal.restoreSelection(selected)
  else { terminal.dispose(); terminals.splice(terminals.indexOf(terminal), 1) }
  for (const [type, listener] of drag) expect(removed).toHaveBeenCalledWith(type, listener)
  if (action === 'restore') {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 48, clientY: 32, buttons: 1, bubbles: true }))
    expect(snapshot(terminal)).toEqual(selected)
    expect(terminal.getSelection()).toBe('BCDEF')
  }
})
