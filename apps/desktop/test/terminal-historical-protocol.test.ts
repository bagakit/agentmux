import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import headless from '@xterm/headless'
import ts from 'typescript'
import { subscribeTerminalInput } from '@agentmux/client-ui/terminal/input'
import { terminalInputSender } from '../src/renderer/src/lib/terminal-reveal'
import { installTerminalOscHandlers } from '../src/renderer/src/lib/terminal-capability-replies'

// Load the small production closure inside the React effect without mounting the app or
// copying its implementation. This also exercises its finally branch on parser failure.
function historicalWriter(writeOutput: (data: Uint8Array) => Promise<void>) {
  const source = readFileSync(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration: ts.VariableDeclaration | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'writeHistoricalOutput') declaration = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(declaration, 'historical output must have a production writer').toBeDefined()
  const code = ts.transpileModule(`let historicalOutputDepth = 0; const ${declaration!.getText(file)};
    return { write: writeHistoricalOutput, replaying: () => historicalOutputDepth > 0 };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function('writeOutput', code)(writeOutput) as {
    write: (data: Uint8Array) => Promise<void>; replaying: () => boolean
  }
}

describe('historical terminal parsing does not answer the current process', () => {
  it.each(['\x1b[6n', '\x1b[c'])('suppresses historical %j, then answers live queries and preserves user input', async (query) => {
    const terminal = new headless.Terminal({ cols: 225, rows: 69, allowProposedApi: true })
    const parsed: string[] = []
    const sent: unknown[] = []
    const history = historicalWriter((data) => new Promise<void>((resolve) => terminal.write(data, resolve)))
    const send = terminalInputSender({
      accepts: () => true, // Live refresh/backfill starts after input is already healthy.
      replaying: history.replaying,
      write: (data, source) => sent.push({ data, source })
    })
    const subscription = subscribeTerminalInput({
      // Headless 5.5 has no public user-input event; its actual parser onData is used below.
      onUserInput: () => ({ dispose() {} }),
      onData: (listener) => terminal.onData((data) => { parsed.push(data); listener(data) }),
      onBinary: (listener) => terminal.onBinary(listener)
    }, send)
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))
    try {
      const historical = history.write(new TextEncoder().encode(`\x1b[66;3H${query}`))
      send('human text', 'user')
      send(Uint8Array.of(0x80, 0xff), 'user')
      await historical
      const reply = query === '\x1b[6n' ? '\x1b[66;3R' : '\x1b[?1;2c'
      expect(parsed).toEqual([reply]) // Real xterm produced a reply from the past screen.
      expect(sent).toEqual([
        { data: 'human text', source: 'user' },
        { data: Uint8Array.of(0x80, 0xff), source: 'user' }
      ])
      expect(history.replaying()).toBe(false)
      terminal.resize(191, 50)
      await write(`\x1b[50;3H${query}`)
      expect(sent.at(-1)).toEqual({
        data: query === '\x1b[6n' ? '\x1b[50;3R' : '\x1b[?1;2c',
        source: 'terminal-protocol'
      })
    } finally { subscription.dispose(); terminal.dispose() }
  })

  it('releases the historical parser scope after failure without closing healthy input', async () => {
    const history = historicalWriter(async () => { throw new Error('parser failed') })
    await expect(history.write(Uint8Array.of(1))).rejects.toThrow('parser failed')
    expect(history.replaying()).toBe(false)
    const sent: string[] = []
    terminalInputSender({ accepts: () => true, replaying: history.replaying,
      write: (data) => sent.push(String(data)) })('\x1b[50;3R', 'terminal-protocol')
    expect(sent).toEqual(['\x1b[50;3R'])
  })

  it('does not repeat historical clipboard writes, then handles a live OSC 52', async () => {
    const terminal = new headless.Terminal({ allowProposedApi: true })
    let replaying = true
    const copied: string[] = []
    // Headless 5.5 lacks the browser 6.1 parser's APC method. This handler uses
    // only their shared registerOscHandler API; keep the production type unchanged.
    const handlers = installTerminalOscHandlers(terminal as unknown as Parameters<typeof installTerminalOscHandlers>[0], {
      isReplaying: () => replaying, respondFromRenderer: true,
      sendInput: () => { throw new Error('A clipboard write is not process input') },
      writeClipboard: (text) => copied.push(text)
    })
    try {
      const osc = '\x1b]52;c;aGlzdG9yeQ==\x07'
      await new Promise<void>((resolve) => terminal.write(osc, resolve))
      expect(copied).toEqual([])
      replaying = false
      await new Promise<void>((resolve) => terminal.write(osc, resolve))
      expect(copied).toEqual(['history'])
    } finally { handlers.dispose(); terminal.dispose() }
  })

  it('the live terminal wires both continuation and retained history to the protocol-only guard', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url), 'utf8')
    const sender = source.slice(source.indexOf('const sendInput = terminalInputSender({'), source.indexOf('const pasteInput ='))
    expect(sender).toContain('replaying: () => replayingContinuation || historicalOutputDepth > 0')
    const osc = source.slice(source.indexOf('const oscHandlers ='), source.indexOf('writeClipboard:', source.indexOf('const oscHandlers =')))
    expect(osc).toContain('isReplaying: () => replayingContinuation || historicalOutputDepth > 0')
    const backfill = source.slice(source.indexOf('const backfillRetainedOutput ='), source.indexOf('const applyContinuation ='))
    expect(backfill).toContain('write: writeHistoricalOutput')
    const historical = source.slice(source.indexOf('const writeHistoricalOutput ='), source.indexOf('const backfillRetainedOutput ='))
    expect(historical).toMatch(/historicalOutputDepth\+\+[\s\S]*try[\s\S]*await writeOutput\(data\)[\s\S]*finally[\s\S]*historicalOutputDepth--/)
  })
})
