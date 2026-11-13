// @vitest-environment happy-dom
// Built public CLI and private RPC transport; the Main manager and asset owner are production code.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxControlServer, connectAgentMuxRpc, parseAgentMuxControlRequest } from '../../../packages/core/src/control-host.js'
import { parseBrowserTaskControlResult, assertBrowserTaskControlTarget } from '../../../packages/core/src/browser-task-control.js'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'
import { executeBrowserTaskControl } from '../src/main/browser-task-control.js'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import type { BrowserTaskAssetDocument } from '../src/shared/browser-task-assets.js'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  fail = false
  async load() { return structuredClone(this.document) }
  async save(document: BrowserTaskAssetDocument) {
    if (this.fail) throw new Error('Private store unavailable')
    this.document = structuredClone(document)
  }
}
const browserId = 'original-browser', url = 'https://generic.invalid/form'
const base = { schemaVersion: 5, requestId: 'authoring-request' } as const
const initial = useAppStore.getState()
let directory: string
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'amx-task-authoring-')) })
afterAll(async () => { if (directory) await rm(directory, { recursive: true }) })
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

async function fixture() {
  const store = new MemoryStore(); let next = 0, now = 10
  const assets = new BrowserTaskAssets(store, { id: () => `original-${++next}`, now: () => now++ })
  const imported = await assets.importRecording({ id: 'real-recording', browserId, navigationId: 'recorded-navigation', url,
    revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const draft = await assets.edit(imported.id, imported.revision, { name: 'Original draft', url, parameters: [], steps: [
    { id: 'approval', kind: 'checkpoint', url, reviewed: true },
    { id: 'navigate', kind: 'navigate', url, reviewed: true }
  ] })
  const asset = await assets.saveVersion(draft.id, draft.revision)
  const entry = { id: browserId, humanControl: false, activity: { control: 'agent' }, view: { webContents: { isDestroyed: () => false } } }
  const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(manager, { entries: new Map([[browserId, entry], ['another-browser', { ...entry, id: 'another-browser' }]]), taskAssets: assets, taskExecutions: new Map() })
  vi.spyOn(manager as any, 'emit').mockImplementation(() => {})
  vi.spyOn(manager as any, 'applyAgentControl').mockImplementation(() => { entry.humanControl = false; entry.activity.control = 'agent'; return {} })
  vi.spyOn(manager as any, 'yieldControl').mockImplementation(() => { entry.humanControl = true; entry.activity.control = 'human' })
  await manager.runTaskAsset({ browserId, assetId: asset.id, version: 1, parameters: {} })
  const actions = vi.spyOn(manager, 'runScript')
  const returnControl = vi.spyOn(manager, 'returnControl')
  const run = vi.spyOn(manager, 'runControlledTaskAsset')
  const automation = vi.fn(async () => { throw new Error('Page execution is disabled') })
  const owner = {
    getTaskAssets: (id: string) => manager.getTaskAssets(id), getOperation: vi.fn(async () => null),
    saveTaskAssetDraft: (id: string, assetId: string, revision: number, content: unknown) => manager.saveTaskAssetDraft(id, assetId, revision, content),
    publishTaskAsset: (id: string, assetId: string, revision: number) => manager.publishTaskAsset(id, assetId, revision),
    runControlledTaskAsset: (input: any) => manager.runControlledTaskAsset(input),
    runControlledTaskBatch: (input: any) => manager.runControlledTaskBatch(input),
    stopTaskAsset: (id: string, runId: string) => manager.stopTaskAsset(id, runId),
    stopTaskBatch: (id: string, batchId: string) => manager.stopTaskBatch(id, batchId)
  }
  return { store, assets, asset, manager, owner, automation, actions, returnControl, run }
}
async function transport<T>(f: Awaited<ReturnType<typeof fixture>>, action: (path: string) => Promise<T>) {
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [],
    execute: request => executeBrowserTaskControl(request, f.owner, f.automation) })
  await server.start()
  try { return await action(server.path) } finally { await server.stop() }
}
async function cli(args: string[], input = '') {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [resolve('packages/core/dist/agentmux.js'), 'browser', 'task', ...args], {
      cwd: resolve('.'), env: objectCliEnvironment(directory), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Private public CLI did not finish')) }, 10_000)
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    child.stdin.on('error', () => {}); child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); accept({ code: code ?? -1, stdout, stderr }) })
    child.stdin.end(input)
  })
}
const flags = (assetId: string, revision: number) => ['--browser', browserId, '--asset', assetId, '--expected-revision', String(revision)]

describe('public task authoring consumes the original Main asset owner', () => {
  it('built CLI → RPC → Main edits and publishes the original asset while immutable versions and pending runs remain', async () => {
    const f = await fixture(), before = await f.assets.state(browserId)
    expect(before.assets).toHaveLength(1); expect(before.assets[0]?.versions).toHaveLength(1)
    expect(before.runs).toMatchObject([{ status: 'waiting-human', pendingCheckpointId: 'approval' }])
    await transport(f, async () => {
      const content = { ...f.asset.draft, name: 'Public draft', steps: f.asset.draft.steps.map(step => ({ ...step, reviewed: false })) }
      const edited = await cli(['edit', ...flags(f.asset.id, f.asset.revision), '--input', '-'], JSON.stringify(content))
      expect(edited.code, edited.stderr).toBe(0)
      expect(objectCliReceipt(JSON.parse(edited.stdout))).toMatchObject({ operation: 'browser.task.edit', result: {
        asset: { id: f.asset.id, browserId, revision: f.asset.revision + 1 } } })
      const actual = await f.assets.get(f.asset.id)
      expect(actual?.draft).toEqual(content); expect(actual?.versions).toEqual(f.asset.versions); expect(actual?.sourceRecordingId).toBe('real-recording')
      const published = await cli(['publish', ...flags(f.asset.id, f.asset.revision + 1)])
      expect(published.code, published.stderr).toBe(0)
      const saved = await f.assets.get(f.asset.id)
      expect(saved?.revision).toBe(f.asset.revision + 2); expect(saved?.versions).toHaveLength(2)
      expect(saved?.versions[1]).toMatchObject({ ...content, version: 2 })
      const later = { ...content, name: 'Later draft' }, path = join(directory, 'draft.json')
      await writeFile(path, JSON.stringify(later))
      const changed = await cli(['edit', ...flags(f.asset.id, saved!.revision), '--input', path])
      expect(changed.code, changed.stderr).toBe(0)
      const state = await f.manager.getTaskAssets(browserId)
      expect(state.assets[0]?.draft).toEqual(later); expect(state.assets[0]?.versions).toEqual(saved?.versions)
      expect(state.runs).toEqual(before.runs); expect(state.selectedRunId).toBe(before.selectedRunId)
      const reloaded = new BrowserTaskAssets(f.store)
      expect(await reloaded.get(f.asset.id)).toEqual(state.assets[0])
    })
    for (const effect of [f.actions, f.returnControl, f.run, f.automation, f.owner.getOperation]) expect(effect).not.toHaveBeenCalled()
  })

  it('public client and CLI retain typed revision conflicts and exact Browser ownership without edits', async () => {
    const f = await fixture(), before = await f.assets.state(browserId)
    await transport(f, async path => {
      const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      try {
        await expect(client.call('browser.task.edit', { browserId, assetId: f.asset.id, expectedRevision: 1, content: f.asset.draft })).rejects.toMatchObject({
          code: 'BROWSER_TASK_REVISION_CONFLICT', detail: JSON.stringify({ browserId, assetId: f.asset.id, expectedRevision: 1, currentRevision: f.asset.revision }) })
        await expect(client.call('browser.task.publish', { browserId: 'another-browser', assetId: f.asset.id, expectedRevision: f.asset.revision })).rejects.toThrow('does not belong')
      } finally { await client.dispose() }
      const stale = await cli(['publish', ...flags(f.asset.id, 1)])
      expect(stale.code).toBe(1)
      expect(JSON.parse(stale.stderr)).toMatchObject({ error: { code: 'BROWSER_TASK_REVISION_CONFLICT' } })
    })
    expect(await f.assets.state(browserId)).toEqual(before)
  })

  it('built CLI edit/publish return exact compact receipts when cumulative history exceeds the response budget', async () => {
    const f = await fixture()
    const history = { ...f.asset.draft, steps: Array.from({ length: 32 }, (_, index) => ({
      id: `retained-${index}`, kind: 'navigate' as const, url: `https://generic.invalid/${'h'.repeat(1800)}`, reviewed: true
    })) }
    let retained = f.asset
    for (let version = 0; version < 20; version++) {
      retained = await f.assets.edit(retained.id, retained.revision, { ...history, name: `Retained version ${version}` })
      retained = await f.assets.saveVersion(retained.id, retained.revision)
    }
    expect(Buffer.byteLength(JSON.stringify(retained))).toBeGreaterThan(1_048_576)
    const previousVersions = structuredClone(retained.versions), previousRuns = (await f.assets.state(browserId)).runs
    await transport(f, async () => {
      const replacement = { ...f.asset.draft, name: 'Edited with retained history' }
      const edited = await cli(['edit', ...flags(retained.id, retained.revision), '--input', '-'], JSON.stringify(replacement))
      expect((await f.assets.get(retained.id))?.draft).toEqual(replacement)
      expect(edited.code, edited.stderr).toBe(0)
      expect(objectCliReceipt(JSON.parse(edited.stdout)).result).toEqual({ asset: { id: retained.id, browserId, revision: retained.revision + 1 } })
      expect(Buffer.byteLength(edited.stdout)).toBeLessThan(1024)
      const published = await cli(['publish', ...flags(retained.id, retained.revision + 1)])
      const actual = await f.assets.get(retained.id)
      expect(actual?.revision).toBe(retained.revision + 2)
      expect(published.code, published.stderr).toBe(0)
      expect(objectCliReceipt(JSON.parse(published.stdout)).result).toEqual({ asset: { id: retained.id, browserId, revision: retained.revision + 2 },
        publishedVersion: previousVersions.length + 1 })
      expect(Buffer.byteLength(published.stdout)).toBeLessThan(1024)
      expect(actual?.versions.slice(0, -1)).toEqual(previousVersions)
      expect(actual?.versions.at(-1)).toMatchObject({ ...replacement, version: previousVersions.length + 1 })
      expect((await f.assets.state(browserId)).runs).toEqual(previousRuns)
      expect(f.store.document?.assets[0]?.versions).toEqual(actual?.versions)
    })
    expect(f.automation).not.toHaveBeenCalled(); expect(f.actions).not.toHaveBeenCalled()
  })

  it('rejects unknown envelope/definition fields and invalid JSON without swallowing the requested data', async () => {
    const f = await fixture(), before = structuredClone(f.store.document)
    const request = { ...base, operation: 'browser.task.edit', browserId, assetId: f.asset.id, expectedRevision: f.asset.revision, content: f.asset.draft }
    for (const extra of [{ sourceRecordingId: 'forged' }, { runId: 'invented' }]) {
      expect(() => parseAgentMuxControlRequest({ ...request, ...extra })).toThrow('unsupported')
    }
    for (const content of [
      { ...f.asset.draft, humanCheckpoints: [{ origin: 'trusted-ui' }] },
      { ...f.asset.draft, steps: [{ ...f.asset.draft.steps[0], approved: true }] },
      { ...f.asset.draft, parameters: [{ key: 'value', label: 'Value', secret: false, value: 'not-definition' }] }
    ]) await expect(executeBrowserTaskControl({ ...request, content }, f.owner, false)).rejects.toThrow('unsupported task draft field')
    const bad = await cli(['edit', ...flags(f.asset.id, f.asset.revision), '--input', '-'], '{"sentinel-unparsed-input":')
    expect(bad.code).toBe(1); expect(bad.stderr).not.toContain('sentinel-unparsed-input')
    expect(f.store.document).toEqual(before); expect((await f.assets.get(f.asset.id))?.draft).toEqual(f.asset.draft)
  })

  it('publish validates the original current draft path, and GUI save reuses that same publish owner', async () => {
    const f = await fixture()
    const published = vi.spyOn(f.manager, 'publishTaskAsset')
    const fromGui = await f.manager.saveTaskAssetVersion(browserId, f.asset.id, f.asset.revision, { ...f.asset.draft, name: 'GUI saved' })
    expect(published).toHaveBeenCalledExactlyOnceWith(browserId, f.asset.id, f.asset.revision + 1)
    expect(fromGui.versions).toHaveLength(2)
    const empty = await f.assets.edit(f.asset.id, fromGui.revision, { ...f.asset.draft, steps: [] })
    await expect(executeBrowserTaskControl({ operation: 'browser.task.publish', browserId, assetId: empty.id, expectedRevision: empty.revision }, f.owner, false)).rejects.toThrow('no steps')
    const invalid = await f.assets.edit(f.asset.id, empty.revision, { ...f.asset.draft, steps: [{ id: 'navigate', kind: 'navigate', url, reviewed: true, nextStepId: 'missing' }] })
    await expect(executeBrowserTaskControl({ operation: 'browser.task.publish', browserId, assetId: invalid.id, expectedRevision: invalid.revision }, f.owner, false)).rejects.toThrow()
    expect(await f.assets.get(f.asset.id)).toEqual(invalid)
  })

  it('authoring an existing asset needs no native page or page-execution permission', async () => {
    const f = await fixture()
    Object.assign(f.manager, { entries: new Map() })
    const saved = await executeBrowserTaskControl({ operation: 'browser.task.edit', browserId, assetId: f.asset.id,
      expectedRevision: f.asset.revision, content: { ...f.asset.draft, name: 'Cold page draft' } }, f.owner, f.automation)
    expect(saved).toEqual({ operation: 'browser.task.edit', asset: { id: f.asset.id, browserId, revision: f.asset.revision + 1 } })
    expect((await f.assets.get(f.asset.id))?.draft.name).toBe('Cold page draft')
    const published = await executeBrowserTaskControl({ operation: 'browser.task.publish', browserId, assetId: f.asset.id,
      expectedRevision: f.asset.revision + 1 }, f.owner, f.automation)
    expect(published).toEqual({ operation: 'browser.task.publish', asset: { id: f.asset.id, browserId, revision: f.asset.revision + 2 }, publishedVersion: 2 })
    expect((await f.assets.get(f.asset.id))?.versions).toHaveLength(2)
    expect(f.automation).not.toHaveBeenCalled(); expect(f.actions).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })

  it('storage failure exposes the retained live revision and warning instead of claiming a saved write', async () => {
    const f = await fixture(), durable = structuredClone(f.store.document)
    f.store.fail = true
    await transport(f, async () => {
      const edit = await cli(['edit', ...flags(f.asset.id, f.asset.revision), '--input', '-'], JSON.stringify({ ...f.asset.draft, name: 'Retained live draft' }))
      expect(edit.code).toBe(1)
      expect(JSON.parse(edit.stderr)).toMatchObject({ error: { code: 'BROWSER_TASK_SAVE_UNCONFIRMED', detail: JSON.stringify({ browserId, assetId: f.asset.id, currentRevision: f.asset.revision + 1, saved: 'unconfirmed' }) } })
    })
    expect(f.store.document).toEqual(durable)
    const live = await f.assets.state(browserId)
    expect(live.warning).toContain('could not be saved')
    expect(live.assets[0]).toMatchObject({ revision: f.asset.revision + 1, draft: { name: 'Retained live draft' } })
    expect(live.runs).toEqual(durable?.runs)
    await expect(executeBrowserTaskControl({ operation: 'browser.task.publish', browserId, assetId: f.asset.id,
      expectedRevision: f.asset.revision + 1 }, f.owner, false)).rejects.toMatchObject({ code: 'BROWSER_TASK_SAVE_UNCONFIRMED' })
    const afterPublish = await f.assets.state(browserId)
    expect(afterPublish.assets[0]?.versions).toHaveLength(2)
    expect(afterPublish.assets[0]?.revision).toBe(f.asset.revision + 2)
    expect(afterPublish.runs).toEqual(live.runs); expect(f.store.document).toEqual(durable)
  })

  it('Renderer refuses authoring at Main-only boundary without creation, page work or spatial mutations', async () => {
    const session: SessionSnapshot = { id: 'retained-agent', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: fixturePath('repo'),
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
      label: 'Retained Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: 1 }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'retained-agent', run: { runId: 'retained-run' } } }
    const tab = createWorkbenchTab('retained-tab', { regionId: 'retained-region', kind: 'agent', phase: 'attached', workspaceId: 'original-workspace', sessionId: session.id })
    useAppStore.setState({ sessions: [session], tabs: { [tab.id]: tab }, layouts: { 'original-workspace': createWorkspaceLayout('original-group', [tab.id]) },
      browserOpinionDrafts: { retained: { original: null, text: 'Unsent draft', includeContext: true, pending: null } } })
    const before = useAppStore.getState(), snapshot = structuredClone({ tabs: before.tabs, layouts: before.layouts, sessions: before.sessions, drafts: before.browserOpinionDrafts })
    const effects = [vi.spyOn(api.browser, 'create'), vi.spyOn(api.browser, 'controlTask'), vi.spyOn(api.sessions, 'launchAgent'),
      vi.spyOn(api.sessions, 'launchTerminal'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'interrupt'), vi.spyOn(api.spatial, 'openAgent'), vi.spyOn(api.spatial, 'commit')]
    for (const operation of ['browser.task.edit', 'browser.task.publish'] as const) {
      const request = parseAgentMuxControlRequest({ ...base, operation, browserId, assetId: 'original-asset', expectedRevision: 1,
        ...(operation === 'browser.task.edit' ? { content: { name: 'Draft', url, steps: [], parameters: [] } } : {}) })
      await expect(useAppStore.getState().executeControl(request)).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: 'Browser task authoring belongs to the Main asset owner.' })
    }
    const after = useAppStore.getState()
    for (const key of ['tabs', 'layouts', 'sessions', 'browserOpinionDrafts'] as const) expect(after[key]).toBe(before[key])
    expect({ tabs: after.tabs, layouts: after.layouts, sessions: after.sessions, drafts: after.browserOpinionDrafts }).toEqual(snapshot)
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
  })

  it('discovery describes exact full-draft input, mutation boundaries and recovery; result codec fences target/revision', () => {
    expect(agentMuxCommandHelp('browser.task.edit')).toContain('--expected-revision N --input FILE|-')
    expect(agentMuxCommandHelp('browser.task.publish')).toContain('cannot approve')
    expect(agentMuxCommandHelp('browser.task')).toContain('task edit')
    expect(agentMuxModuleSkill('browser')).toContain('browser task')
    const request = { operation: 'browser.task.publish', browserId, assetId: 'original-asset', expectedRevision: 2 } as const
    const result = parseBrowserTaskControlResult(request.operation, { asset: { id: request.assetId, browserId, revision: 3 }, publishedVersion: 1 })
    expect(() => assertBrowserTaskControlTarget(request, result)).not.toThrow()
    expect(() => assertBrowserTaskControlTarget({ ...request, assetId: 'other-asset' }, result)).toThrow('another asset or revision')
    expect(() => assertBrowserTaskControlTarget({ ...request, expectedRevision: 1 }, result)).toThrow('another asset or revision')
    expect(() => parseBrowserTaskControlResult(request.operation, { asset: { id: request.assetId, browserId, revision: 3 }, publishedVersion: 0 })).toThrow('count or version')
  })
})
