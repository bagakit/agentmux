import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { assertSenderTrusted, senderTrust, type PrivilegedChannel } from '../src/main/ipc-sender-trust'

// Execute the actual registered callbacks without importing the application-wide Electron boot.
// Extraction must find exactly one real registration; a missing/renamed callback cannot pass vacuously.
function fixture() {
  const source = ts.createSourceFile('ipc.ts', readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const mainFrame = {}, sender = {}, open = vi.fn(async () => ({ id: 'original-preview', url: 'http://127.0.0.1/original-preview/report.html' })), release = vi.fn()
  const resource = { id: 'workspace', hostId: 'local', path: _hygiene_fixturePath("original") }
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'handleWithEvent' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
      ['files:openHtmlPreview', 'files:releaseHtmlPreview'].includes(node.arguments[0].text)) {
      const channel = node.arguments[0].text
      expect(handlers[channel]).toBeUndefined()
      const js = ts.transpile(`(${node.arguments[1]!.getText(source)})`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
      handlers[channel] = new Function('requireTrustedSender', 'args', 'htmlPreviews', 'workspace', 'config', `return ${js}`)(
        (channel: PrivilegedChannel, event: { sender: unknown }) => assertSenderTrusted(senderTrust(channel, event.sender, sender)),
        { window: { webContents: { mainFrame } } }, { open, release }, (_config: unknown, id: string) => {
          if (id !== resource.id) throw new Error('Unknown original workspace')
          return resource
        }, {})
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(Object.keys(handlers).sort()).toEqual(['files:openHtmlPreview', 'files:releaseHtmlPreview'])
  return { handlers, mainFrame, sender, open, release, resource }
}

describe('HTML preview production IPC registration', () => {
  it('forwards the exact current workspace, path and draft, and releases the exact returned preview', async () => {
    const f = fixture(), event = { sender: f.sender, senderFrame: f.mainFrame }
    expect(await f.handlers['files:openHtmlPreview']!(event, 'workspace', 'pages/report.html', '<h1>Unsaved</h1>')).toMatchObject({ id: 'original-preview' })
    expect(f.open).toHaveBeenCalledExactlyOnceWith(f.resource, 'pages/report.html', '<h1>Unsaved</h1>')
    await f.handlers['files:releaseHtmlPreview']!(event, 'original-preview')
    expect(f.release).toHaveBeenCalledExactlyOnceWith('original-preview')
  })
  it.each(['files:openHtmlPreview', 'files:releaseHtmlPreview'])('refuses an untrusted sender or subframe before %s can operate the owner', async channel => {
    const f = fixture()
    await expect(f.handlers[channel]!({ sender: {}, senderFrame: f.mainFrame }, 'workspace', 'report.html', '<h1>Unknown</h1>')).rejects.toThrow('Untrusted')
    await expect(f.handlers[channel]!({ sender: f.sender, senderFrame: {} }, 'workspace', 'report.html', '<h1>Unknown</h1>')).rejects.toThrow('original application frame')
    expect(f.open).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled()
  })
  it('propagates listener failures so the current source can remain available for retry', async () => {
    const f = fixture(); f.open.mockRejectedValueOnce(new Error('Listener unavailable'))
    await expect(f.handlers['files:openHtmlPreview']!({ sender: f.sender, senderFrame: f.mainFrame }, 'workspace', 'report.html', '<h1>Retain</h1>')).rejects.toThrow('Listener unavailable')
    expect(f.release).not.toHaveBeenCalled()
  })
})
