import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { terminalContextPathAtBufferCell } from '../src/renderer/src/lib/terminal-context-path'
import { terminalFileMenuActions } from '../src/renderer/src/lib/terminal-file-action'

const root = new URL("workspace", new URL('/', import.meta.url)).pathname
const osc = (uri: string, label = '下载') => `\x1b]8;;${uri}\x07${label}\x1b]8;;\x07`
async function withTerminal(text: string, check: (terminal: Terminal) => void | Promise<void>) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 8 })
  try {
    await new Promise<void>(done => terminal.write(text, done))
    await check(terminal)
  } finally { terminal.dispose() }
}

describe('terminal context path uses current native declared target', () => {
  it('reveals a labeled local artifact once through the existing menu action', async () => {
    await withTerminal(osc(("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "release/App%20%E4%B8%AD.dmg")), terminal => {
      for (const x of [1, 2, 3, 4]) {
        expect(terminalContextPathAtBufferCell(terminal, x, 1, root)?.path).toBe('release/App 中.dmg')
      }
      expect(terminalContextPathAtBufferCell(terminal, 5, 1, root)).toBeNull()
      const reveal = vi.fn(), open = vi.fn()
      const actions = terminalFileMenuActions({ link: terminalContextPathAtBufferCell(terminal, 2, 1, root), local: true,
        onReveal: reveal, onOpenSystem: open })
      expect(actions.map(action => action.key)).toEqual(['reveal', 'open-system'])
      actions[0]!.onSelect()
      expect(reveal).toHaveBeenCalledExactlyOnceWith('release/App 中.dmg')
      expect(open).not.toHaveBeenCalled()
    })
  })

  it.each([new URL("workspace/release/App.dmg", new URL('/', import.meta.url)).pathname, './release/App.dmg', ("file://localhost" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "release/App.dmg")])(
    'resolves the original explicit file target %s', async uri => {
      await withTerminal(osc(uri), terminal => expect(terminalContextPathAtBufferCell(terminal, 1, 1, root)?.path).toBe('release/App.dmg'))
    })

  it.each(['https://example.test/file', 'javascript:alert(1)', ("file://other" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a.dmg"),
    ("file://" + new URL("outside/", new URL('/', import.meta.url)).pathname + "a.dmg"), ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a.dmg?download=1"), ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a.dmg#fragment"),
    ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a%2fb.dmg"), ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a%00.dmg"),
    ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a.dmg?"), ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a.dmg#"), ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a\\b.dmg"), ("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "a%0ab.dmg")])(
    'does not borrow a path-shaped label from %s', async uri => {
      await withTerminal(osc(uri, 'release/fake.dmg'), terminal => expect(terminalContextPathAtBufferCell(terminal, 3, 1, root)).toBeNull())
    })

  it('reads wrapped label cells and decodes the declared pathname only once', async () => {
    await withTerminal(osc(("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "release/App%2520.dmg"), 'abcdefghijklmnopqrst继续下载'), terminal => {
      expect(terminalContextPathAtBufferCell(terminal, 2, 2, root)?.path).toBe('release/App%20.dmg')
    })
  })

  it('does not borrow the label when native URI metadata is unavailable', async () => {
    await withTerminal(osc(("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "real.dmg"), 'release/fake.dmg'), terminal => {
      const service = (terminal as any)._core._oscLinkService
      const spy = vi.spyOn(service, 'getLinkData').mockReturnValue(undefined)
      expect(terminalContextPathAtBufferCell(terminal, 3, 1, root)).toBeNull()
      spy.mockRestore()
    })
  })

  it('follows current buffer cells after overwrite and reset without a hover cache', async () => {
    await withTerminal(osc(("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "old.dmg"), 'artifact'), async terminal => {
      expect(terminalContextPathAtBufferCell(terminal, 1, 1, root)?.path).toBe('old.dmg')
      await new Promise<void>(done => terminal.write('\r\x1b[2K'+osc(("file://" + new URL("workspace/", new URL('/', import.meta.url)).pathname + "new.dmg"), 'artifact'), done))
      expect(terminalContextPathAtBufferCell(terminal, 1, 1, root)?.path).toBe('new.dmg')
      terminal.reset()
      expect(terminalContextPathAtBufferCell(terminal, 1, 1, root)).toBeNull()
    })
  })

  it('keeps bare paths and remote menu policy', async () => {
    await withTerminal('release/App.dmg', terminal => {
      const link = terminalContextPathAtBufferCell(terminal, 3, 1, root)
      expect(link?.path).toBe('release/App.dmg')
      expect(terminalFileMenuActions({ link, local: false, onReveal: vi.fn(), onOpenSystem: vi.fn() })).toEqual([])
      expect(terminalContextPathAtBufferCell(terminal, 0, 1, root)).toBeNull()
      expect(terminalContextPathAtBufferCell(terminal, 1, 0, root)).toBeNull()
    })
  })
})
