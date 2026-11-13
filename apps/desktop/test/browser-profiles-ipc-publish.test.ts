import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL as NodeURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, session: { fromPartition: () => ({ clearStorageData: async () => {}, flushStorageData: async () => {} }) }, BrowserWindow: class {} }))

import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { ipcResult, unwrapIpcResult, type IpcResult } from '../src/shared/ipc-result.js'
import { readBrowserProfileSnapshot, registerBrowserProfileEditorIpc } from '../src/main/browser-profile-editor-ipc.js'

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111'
const WORK_ID = '22222222-2222-4222-8222-222222222222'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

// Compile the production Profile handlers and the one change subscription from ipc.ts.
function productionWiring(names: string[], scope: Record<string, unknown>): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const source = readFileSync(new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  const found: Record<string, string> = {}
  const bound: Record<string, (...args: any[]) => any> = {}
  let editorBinding = 0
  const subscriptions: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'handleWithEvent' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && names.includes(node.arguments[0].text)) {
      found[node.arguments[0].text] = node.arguments[1]!.getText(parsed)
    }
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'registerBrowserProfileEditorIpc') {
      expect(node.arguments[0]?.getText(parsed)).toBe('{ handle: handleWithEvent, profiles: browserProfiles }')
      editorBinding++
      registerBrowserProfileEditorIpc({ profiles: scope.browserProfiles as BrowserProfileManager, handle: (channel, handler) => { if (names.includes(channel)) bound[channel] = handler } })
    }
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'browserProfiles.onChange') {
      // The proxy credential owner also observes metadata changes. Select the actual Renderer
      // publication, rather than treating every original-owner observer as a UI subscription.
      let publishes = false
      const publication = (child: ts.Node) => {
        if (ts.isCallExpression(child) && child.expression.getText(parsed) === 'contents.send' &&
          child.arguments[0] && ts.isStringLiteral(child.arguments[0]) && child.arguments[0].text === 'browser:profilesChanged') publishes = true
        ts.forEachChild(child, publication)
      }
      ts.forEachChild(node, publication)
      if (publishes) subscriptions.push(node.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(editorBinding).toBe(1)
  expect([...Object.keys(found), ...Object.keys(bound)].sort()).toEqual([...names].sort())
  expect(subscriptions, 'ipc.ts subscribes to Profile changes exactly once').toHaveLength(1)
  const body = `${subscriptions[0]}; return { ${Object.keys(found).map(n => `${JSON.stringify(n)}: ${found[n]}`).join(', ')} };`
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return { ...bound, ...new Function(...Object.keys(scope), compiled)(...Object.values(scope)) }
}

async function manager() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-browser-profiles-publish-'))
  roots.push(root)
  const path = join(root, 'browser-profiles.json')
  await writeFile(path, JSON.stringify({ version: 1, defaultProfileId: DEFAULT_ID, pendingImports: [], profiles: [
    { id: DEFAULT_ID, label: 'Personal', createdAt: 1, source: null }, { id: WORK_ID, label: 'Work', createdAt: 2, source: null }] }))
  const profiles = new BrowserProfileManager(new BrowserProfileStore(path))
  await profiles.initialize()
  return profiles
}

describe('Main publishes the committed Profile list after every change', () => {
  it('publishes original environment notifications without inventing a persistent sequence', async () => {
    const profiles = await manager(), sequence = profiles.listSequence(), revision = profiles.listRevision()
    let notify!: () => void
    const sent: unknown[] = []
    const source = readFileSync(new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const parsed = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true), subscriptions: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'browserProfiles.onEnvironmentApplicationChange') subscriptions.push(node.getText(parsed))
      ts.forEachChild(node, visit)
    }
    visit(parsed); expect(subscriptions).toHaveLength(1)
    const listener = vi.spyOn(profiles, 'onEnvironmentApplicationChange').mockImplementation(value => { notify = () => value(DEFAULT_ID); return () => {} })
    const compiled = ts.transpileModule(subscriptions[0]!, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    new Function('browserProfiles', 'contents', 'readBrowserProfileSnapshot', compiled)(profiles, { isDestroyed: () => false, send: (_channel: string, value: unknown) => sent.push(value) }, readBrowserProfileSnapshot)
    notify()
    expect(sent).toEqual([readBrowserProfileSnapshot(profiles)])
    expect(profiles.listSequence()).toBe(sequence); expect(profiles.listRevision()).toBe(revision)
    listener.mockRestore(); await profiles.dispose()
  })

  it('sends the manager list once per committed create, update and default move, and never for reads or refusals', async () => {
    const browserProfiles = await manager()
    const sent: Array<[string, { revision: number; profiles: { id: string; label: string; isDefault: boolean }[] }]> = []
    let destroyed = false
    const contents = { isDestroyed: () => destroyed, send: (channel: string, payload: never) => sent.push([channel, payload]) }
    const wired = productionWiring(['browser:readProfiles', 'browser:createProfile', 'browser:updateProfile', 'browser:setDefaultProfile'], { browserProfiles, contents, ipcResult })
    // Handlers return the IPC envelope; unwrap as the Renderer api does so refusals keep their code.
    const h = Object.fromEntries(Object.entries(wired).map(([channel, handler]) => [channel,
      async (...args: unknown[]) => unwrapIpcResult(await handler(...args) as IpcResult<unknown>)])) as typeof wired

    expect(await h['browser:readProfiles']!({})).toMatchObject({ revision: 0 })
    expect(sent).toHaveLength(0)
    await h['browser:createProfile']!({}, 'Client')
    await h['browser:updateProfile']!({}, WORK_ID, { label: 'Work client' }, browserProfiles.listProfiles().find(value => value.id === WORK_ID)!.revision)
    // The default move names only its target; a stale revision argument is not forwarded.
    await h['browser:setDefaultProfile']!({}, WORK_ID, 0)
    expect(sent.map(([channel, payload]) => [channel, payload.revision])).toEqual([
      ['browser:profilesChanged', 1], ['browser:profilesChanged', 2], ['browser:profilesChanged', 3]
    ])
    // Each push is the whole list a fresh read returns, never a field-by-field copy.
    expect(sent.at(-1)![1]).toEqual(await h['browser:readProfiles']!({}))
    expect(sent.at(-1)![1].profiles.map(p => [p.id, p.label, p.isDefault])).toEqual([
      [DEFAULT_ID, 'Personal', false], [WORK_ID, 'Work client', true], [expect.any(String), 'Client', false]
    ])

    await expect(h['browser:updateProfile']!({}, WORK_ID, { label: 'Late' }, 'stale-profile-token')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    await expect(h['browser:setDefaultProfile']!({}, '33333333-3333-4333-8333-333333333333')).rejects.toThrow('Unknown Browser Profile')
    expect(sent).toHaveLength(3)

    destroyed = true
    await h['browser:createProfile']!({}, 'After close')
    expect(sent).toHaveLength(3)
    await browserProfiles.dispose()
  })

  it('returns each production handler refusal as plain data that keeps its code across a structured copy', async () => {
    const browserProfiles = await manager()
    const contents = { isDestroyed: () => false, send: () => {} }
    const h = productionWiring(['browser:readProfiles', 'browser:updateProfile', 'browser:setDefaultProfile'], { browserProfiles, contents, ipcResult })
    // Electron copies handler results with the structured clone algorithm and drops an Error's code; data survives.
    const refused = structuredClone(await h['browser:updateProfile']!({}, WORK_ID, { label: 'Late' }, 'stale-profile-token'))
    expect(refused).toEqual({ ok: false, error: { code: 'BROWSER_PROFILE_REVISION_CONFLICT', message: expect.stringContaining('Profile configuration changed') } })
    expect(() => unwrapIpcResult(refused as IpcResult<unknown>)).toThrowError(expect.objectContaining({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' }))
    expect(structuredClone(await h['browser:readProfiles']!({}))).toMatchObject({ ok: true, value: { revision: 0 } })
    expect(await h['browser:setDefaultProfile']!({}, WORK_ID)).toEqual({ ok: true, value: undefined })
    await browserProfiles.dispose()
  })
})
