import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
/** Execute the real registered callback, rather than a copy of its routing logic. */
function handler(channel: string, dependencies: Record<string, unknown>) {
  const found: ts.Expression[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handleWithEvent' &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === channel && node.arguments[1]) found.push(node.arguments[1])
    ts.forEachChild(node, walk)
  }
  walk(ast)
  expect(found, `Actual Main registration missing or duplicated: ${channel}`).toHaveLength(1)
  const compiled = ts.transpileModule(`const callback = ${found[0]!.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  return new Function(...Object.keys(dependencies), `${compiled};return callback`)(...Object.values(dependencies)) as (...args: unknown[]) => Promise<unknown>
}
function fixture() {
  const embedded = { id: 'embedded', workspaceId: null, source: 'embedded', status: 'ready' }
  const external = { id: 'shared-original', workspaceId: 'workspace-one', source: 'external', status: 'ready' }
  const config = { browser: { agentAutomation: true } }
  const requireTrustedSender = vi.fn((_channel, event) => { if (event !== 'trusted-original') throw new Error('Untrusted original sender') })
  const workspace = vi.fn((_config, id) => { if (id !== external.workspaceId) throw new Error('Unknown original Workspace'); return { id } })
  const externalBrowsers = { has: vi.fn(id => id === external.id), runScript: vi.fn(async (...args) => ({ source: 'external', args })) }
  const browsers = { targets: vi.fn(() => [embedded]), runScript: vi.fn(async (...args) => ({ source: 'embedded', args })) }
  const externalBridge = { list: vi.fn(() => [external]), require: vi.fn(() => external), createPairing: vi.fn(async id => ({ originalWorkspace: id })), stopSharing: vi.fn() }
  return { embedded, external, config, requireTrustedSender, workspace, externalBrowsers, browsers, externalBridge }
}
describe('actual Main external Browser callback consumers', () => {
  it('uses original retained-upload store and an actual local native confirmation, cancelling without deleting', async () => {
    const f = fixture()
    const selection = { id: 'upload-original', files: ['selected.txt'], byteLength: 17 }
    const retained = { selections: [selection] }
    const window = { isDestroyed: vi.fn(() => false) }
    const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) }
    const browserUploads = { retained: vi.fn(async () => retained), confirmDiscardSelection: vi.fn(async (_id, confirm) => await confirm(selection)) }
    const dependencies = { ...f, args: { window }, dialog, browserUploads }
    const list = handler('browser:listRetainedUploads', dependencies)
    const discard = handler('browser:discardRetainedUpload', dependencies)
    expect(await list('trusted-original')).toBe(retained)
    await expect(discard('untrusted-page', selection.id)).rejects.toThrow('Untrusted')
    expect(browserUploads.confirmDiscardSelection).not.toHaveBeenCalled()
    expect(await discard('trusted-original', selection.id)).toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({ message: '原页面后续上传将不可读，先完成或取消上传', defaultId: 0, cancelId: 0, buttons: ['Keep files', 'Discard files'] }))
    dialog.showMessageBox.mockResolvedValue({ response: 1 })
    expect(await discard('trusted-original', selection.id)).toBe(true)
    expect(browserUploads.confirmDiscardSelection.mock.calls.map(call => call[0])).toEqual([selection.id, selection.id])
    window.isDestroyed.mockReturnValue(true)
    expect(await discard('trusted-original', selection.id)).toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })
  it('routes the chosen original external id and caller to its original owner, preserving embedded operation argument positions', async () => {
    const f = fixture(); const run = handler('browser:runScript', f)
    const actor = { id: 'agent-one', name: 'Source Agent' }
    expect(await run('trusted-original', f.external.id, 'return 1', actor, 'operation-one')).toEqual({ source: 'external', args: [f.external.id, 'return 1', actor, 'operation-one'] })
    expect(f.workspace).toHaveBeenCalledWith(f.config, 'workspace-one')
    expect(f.browsers.runScript).not.toHaveBeenCalled()
    expect(await run('trusted-original', f.embedded.id, 'return 2', actor, 'operation-two')).toEqual({ source: 'embedded', args: [f.embedded.id, 'return 2', actor, undefined, 'operation-two'] })
    expect(f.externalBrowsers.runScript).toHaveBeenCalledTimes(1)
  })
  it('sends no owner action for an untrusted sender, automation off, or a lost original Workspace', async () => {
    const f = fixture(); const run = handler('browser:runScript', f)
    await expect(run('another-frame', f.external.id, 'return 1')).rejects.toThrow('Untrusted')
    f.config.browser.agentAutomation = false
    await expect(run('trusted-original', f.external.id, 'return 1')).rejects.toMatchObject({ code: 'BROWSER_AUTOMATION_DISABLED' })
    f.config.browser.agentAutomation = true
    f.externalBridge.require.mockReturnValue({ ...f.external, workspaceId: 'lost-workspace' })
    await expect(run('trusted-original', f.external.id, 'return 1')).rejects.toThrow('Unknown')
    expect(f.externalBrowsers.runScript).not.toHaveBeenCalled(); expect(f.browsers.runScript).not.toHaveBeenCalled()
  })
  it('discovers actual embedded and explicitly shared identities without opening, selecting or focusing a substitute', async () => {
    const f = fixture(); const list = handler('browser:listTargets', f)
    expect(await list('trusted-original')).toEqual({ targets: [f.embedded, f.external] })
    expect(await list('trusted-original', 'workspace-one')).toEqual({ targets: [f.external] })
    expect(f.externalBrowsers.runScript).not.toHaveBeenCalled(); expect(f.browsers.runScript).not.toHaveBeenCalled()
  })
  it('pairs only the explicit trusted Workspace and revokes only the specified original grant', async () => {
    const f = fixture(); const pair = handler('browser:createExternalPairing', f)
    await expect(pair('another-frame', 'workspace-one')).rejects.toThrow('Untrusted')
    await expect(pair('trusted-original', 'other-workspace')).rejects.toThrow('Unknown')
    expect(f.externalBridge.createPairing).not.toHaveBeenCalled()
    expect(await pair('trusted-original', 'workspace-one')).toEqual({ originalWorkspace: 'workspace-one' })
    const stop = handler('browser:stopSharingExternal', f)
    f.config.browser.agentAutomation = false
    expect(stop('trusted-original', 'shared-original')).toBeUndefined()
    expect(f.externalBridge.stopSharing).toHaveBeenCalledExactlyOnceWith('shared-original')
    expect(() => stop('another-frame', 'shared-other')).toThrow('Untrusted')
    expect(f.externalBridge.stopSharing).toHaveBeenCalledTimes(1)
  })
})
