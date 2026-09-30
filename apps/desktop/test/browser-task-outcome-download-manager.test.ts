import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, parseAgentMuxControlReceipt, AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Source boundary: Electron/CDP and Chromium DownloadItem events are doubles.
// Manager, dispatch/ref resolution, asset/journal stores, evaluator, downloads,
// Workspace binary IO and the Main/Core completion projection are production code.
// This is neither a native Chromium transfer nor an application restart proof.
const native = vi.hoisted(() => ({ views: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    readonly id = native.views.length + 41
    url = ''; destroyed = false; attached = false; clicks = 0
    onDownloadClick?: () => Promise<void>
    readonly session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    readonly mainFrame = { framesInSubtree: [] }
    readonly debugger = Object.assign(new EventEmitter(), {
      attach: () => { if (this.attached) throw new Error('Already attached'); this.attached = true },
      detach: () => { this.attached = false }, isAttached: () => this.attached,
      sendCommand: async (method: string, parameters: Record<string, any> = {}) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a', loaderId: 'loader-a' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 11,
          frameId: 'frame-a', role: { value: 'link' }, name: { value: 'Download file' }, childIds: [] }] }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'download-target' } }
        if (method === 'Runtime.callFunctionOn') {
          expect(parameters.functionDeclaration).toContain('this.click()')
          this.clicks += 1; await this.onDownloadClick?.()
          return { result: { value: null } }
        }
        return {}
      }
    })
    isDestroyed() { return this.destroyed }
    isLoading() { return false }
    getURL() { return this.url }
    getTitle() { return 'Generic download page' }
    getZoomFactor() { return 1 }
    setZoomFactor() {}
    disableDeviceEmulation() {}
    enableDeviceEmulation() {}
    setWindowOpenHandler() {}
    async executeJavaScriptInIsolatedWorld() { return true }
    async loadURL(url: string) {
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
      this.url = url; this.emit('did-finish-load')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class View {
    readonly webContents = new Contents()
    constructor() { native.views.push(this) }
    setVisible() {}
    setBounds() {}
  }
  return { WebContentsView: View, app: { getPath: () => tmpdir() } }
})

import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserDownloads } from '../src/main/browser-downloads'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/main/browser-operation-journal'
import { BrowserStepEvidenceStore } from '../src/main/browser-step-evidence'
import { BrowserResultArtifactStore } from '../src/main/browser-result-artifact'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store'
import { BrowserTaskAssetFileStore, BrowserTaskAssets } from '../src/main/browser-task-assets'
import { projectBrowserControlResult } from '../src/main/browser-completion-control'
import type { BrowserTaskAssetRun, BrowserTaskAssetDocument } from '../src/shared/browser-task-assets'
import type { WorkspaceRecord } from '../src/shared/contracts'

class Download extends EventEmitter {
  path: string | null = null; bytes = 0
  constructor(readonly total: number) { super() }
  setSavePath(path: string) { this.path = path }
  getFilename() { return 'artifact.bin' }
  getMimeType() { return 'application/octet-stream' }
  getReceivedBytes() { return this.bytes }
  getTotalBytes() { return this.total }
  cancel() { this.emit('done', {}, 'cancelled') }
}
const payload = Buffer.from([0, 255, 128, 1, 10, 13])
const browserId = 'browser-a', url = 'https://generic.invalid/files', roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  native.views.length = 0
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-task-download-manager-')); roots.push(root)
  const workspace: WorkspaceRecord = { id: 'workspace-a', name: 'Files', hostId: 'local', path: join(root, 'workspace'), kind: 'folder' }
  await mkdir(workspace.path)
  const files = new WorkspaceFiles(() => new LocalExecutionHost()), directory = join(root, 'downloads')
  const journalPath = join(root, 'journal.json'), assetPath = join(root, 'assets.json')
  const resolveWorkspace = (id: string) => { if (id !== workspace.id) throw new Error('Unknown Workspace'); return workspace }
  const createRuntime = async () => {
    const downloads = new BrowserDownloads(directory, files, resolveWorkspace)
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
    const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(assetPath)), children: any[] = []
    const window = { contentView: { children, addChildView: (view: any) => children.push(view),
      removeChildView: (view: any) => children.splice(children.indexOf(view), 1) }, isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send() {} } }
    const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private' },
      new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} },
      journal, new BrowserStepEvidenceStore(join(root, 'evidence')), new BrowserResultArtifactStore(join(root, 'results')), undefined, assets, downloads)
    managers.push(manager); await manager.create(browserId, url, workspace.id)
    return { manager, journal, assets, downloads, contents: children[0].webContents }
  }
  const runtime = await createRuntime()
  const imported = await runtime.assets.importRecording({ id: 'recording-a', browserId, navigationId: 'recorded-navigation',
    url, status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await runtime.assets.edit(imported.id, imported.revision, { ...imported.draft, steps: [
    { id: 'download-a', kind: 'click', url, reviewed: true, target: { role: 'link', name: 'Download file', ordinal: 1, count: 1 } }
  ], completion: { criteria: [{ kind: 'download-readable', stepId: 'download-a', path: 'artifact.bin' }] } })
  const asset = await runtime.assets.saveVersion(edited.id, edited.revision)
  const beforeProducer: any[] = [], waitingMetadata: Array<{ name: string; bytes: Buffer }> = []
  const install = (target = runtime, mode: 'complete' | 'cancelled' | 'stop' = 'complete') => {
    target.contents.onDownloadClick = async () => {
      const document = JSON.parse(await readFile(journalPath, 'utf8'))
      const operations = document.operations
      expect(operations.length).toBeGreaterThan(0)
      const operation = operations.at(-1)
      const assets = JSON.parse(await readFile(assetPath, 'utf8')) as BrowserTaskAssetDocument
      const run = assets.runs.at(-1)!
      expect(run.operationIds).toEqual([operation.id])
      expect(operation.outcome.registration).toEqual({
        context: { workspaceId: workspace.id, browserId, operationId: operation.id, navigationId: operation.outcome.registration.context.navigationId },
        assetRun: { runId: run.id, assetId: asset.id, version: 1 }, criteria: [{ kind: 'download-readable', path: 'artifact.bin',
          producer: { operationId: operation.id, navigationId: operation.outcome.registration.context.navigationId } }]
      })
      expect(run).toMatchObject({ assetId: asset.id, version: 1, browserId, nextStep: 0, status: 'running' })
      expect(operation.steps.map((step: any) => [step.method, step.status])).toEqual([
        ['pageInfo', 'completed'], ['snapshot', 'completed'], ['download', 'running']
      ])
      beforeProducer.push({ operation, run })
      const names = (await readdir(directory)).filter(name => name.endsWith('.json'))
      const entries = await Promise.all(names.map(async name => ({ name, bytes: await readFile(join(directory, name)) })))
      const reserved = entries.filter(entry => JSON.parse(entry.bytes.toString()).receipt.operationId === operation.id)
      expect(reserved).toHaveLength(1); waitingMetadata.push(reserved[0]!)
      expect(target.contents.session.listenerCount('will-download')).toBe(1)
      const item = new Download(payload.length)
      target.contents.session.emit('will-download', {}, item, target.contents)
      expect(item.path).toBeTruthy()
      if (mode === 'cancelled') item.cancel()
      else {
        await writeFile(item.path!, payload)
        if (mode === 'stop') void target.manager.stopOperationById(operation.id)
        else { item.bytes = payload.length; item.emit('done', {}, 'completed') }
      }
    }
  }
  const run = (target = runtime) => target.manager.runTaskAsset({ browserId, assetId: asset.id, version: 1, parameters: {} })
  const verify = async (execution: BrowserTaskAssetRun, status: 'passed' | 'not-met' | 'unavailable', target = runtime) => {
    expect(execution.operationIds).toHaveLength(1)
    const operationId = execution.operationIds[0]!
    await expect(target.manager.verifyOutcome(browserId, operationId)).resolves.toMatchObject({ status,
      assetRun: { runId: execution.id, assetId: asset.id, version: 1 }, conditions: [{ status }] })
    const operation = await target.manager.getOperation(operationId)
    expect(operation?.outcome?.evaluation?.status).toBe(status)
    const result = projectBrowserControlResult({ operation: 'browser.operation', runOperation: operation })
    expect(result.operation).toBe('browser.operation')
    const receipt = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'source-file-check',
      ok: true, operation: 'browser.operation', result: { runOperation: result.operation === 'browser.operation' ? result.runOperation : null } })
    if (!receipt.ok || receipt.operation !== 'browser.operation') throw new Error('Unexpected completion receipt')
    expect(receipt.result.runOperation?.completion).toEqual(operation?.outcome?.evaluation)
    expect(receipt.result.runOperation).not.toHaveProperty('outcome')
    expect(target.contents.session.listenerCount('will-download')).toBe(0)
    expect(target.contents.attached).toBe(false)
    expect(target.contents.isDestroyed()).toBe(false)
    return operation!
  }
  return { root, workspace, files, directory, assetPath, runtime, asset, beforeProducer, waitingMetadata, createRuntime, install, run, verify }
}

describe('download completion through the actual asset Manager and durable file owners', () => {
  it('registers the exact immutable execution before its sole producer and projects the published binary through Main/Core; owner recreation does not download again', async () => {
    const f = await fixture(); f.install()
    const run = await f.run()
    expect(run.status).toBe('completed'); expect(f.beforeProducer).toHaveLength(1)
    expect(f.beforeProducer[0].run.id).toBe(run.id)
    expect(f.runtime.contents.clicks).toBe(1)
    const operation = await f.verify(run, 'passed')
    const records = await f.runtime.downloads.list({ workspaceId: f.workspace.id, browserId })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'completed', operationId: operation.id, reference: { byteLength: payload.length } })
    expect(await readFile(join(f.workspace.path, 'artifact.bin'))).toEqual(payload)
    const chunk = await f.runtime.downloads.read(records[0]!.reference!, { workspaceId: f.workspace.id, browserId })
    expect(Buffer.from(chunk.data, 'base64')).toEqual(payload)
    f.runtime.manager.dispose()
    const restored = await f.createRuntime()
    expect((await restored.assets.state(browserId)).runs).toEqual([run])
    await f.verify(run, 'passed', restored)
    expect(restored.contents.clicks).toBe(0); expect(f.runtime.contents.clicks).toBe(1)
    // Feed the real reconstructed owner valid but foreign execution facts, keeping
    // the producer, completed file and original registration intact.
    const retained = JSON.parse(await readFile(f.assetPath, 'utf8')) as BrowserTaskAssetDocument
    const newer = await restored.assets.saveVersion(f.asset.id, f.asset.revision)
    expect(newer.versions.map(version => version.version)).toEqual([1, 2])
    const withVersions = JSON.parse(await readFile(f.assetPath, 'utf8')) as BrowserTaskAssetDocument
    for (const invalid of ['version', 'operation-join'] as const) {
      const changed = structuredClone(withVersions)
      if (invalid === 'version') changed.runs[0]!.version = 2
      else changed.runs[0]!.operationIds = ['another-operation']
      await writeFile(f.assetPath, JSON.stringify(changed))
      const foreign = await f.createRuntime()
      await f.verify(run, 'unavailable', foreign)
      expect(foreign.contents.clicks).toBe(0)
      foreign.manager.dispose()
    }
    await writeFile(f.assetPath, JSON.stringify(retained))
  }, 30_000)

  it('keeps a known cancelled transfer not-met and retains its interrupted asset and original Browser for inspection', async () => {
    const f = await fixture(); f.install(f.runtime, 'cancelled')
    const run = await f.run(), operation = await f.verify(run, 'not-met')
    expect(run.status).toBe('interrupted'); expect(operation.phase).toBe('indeterminate')
    expect((await f.runtime.downloads.list({ workspaceId: f.workspace.id, browserId })).map(receipt => receipt.status)).toEqual(['cancelled'])
    expect(f.runtime.contents.clicks).toBe(1)
  }, 30_000)

  it('rejects an actual earlier run file after current metadata is lost; no readonly check repeats either producer', async () => {
    const f = await fixture(); f.install()
    const old = await f.run(); await f.verify(old, 'passed')
    await rm(join(f.workspace.path, 'artifact.bin'))
    const current = await f.run()
    expect(current.id).not.toBe(old.id)
    await f.verify(current, 'passed')
    await f.verify(old, 'unavailable')
    const records = await f.runtime.downloads.list({ workspaceId: f.workspace.id, browserId })
    expect(records.map(receipt => receipt.status)).toEqual(['completed', 'completed'])
    const currentReceipt = records.find(receipt => receipt.operationId === current.operationIds[0])!
    await rm(join(f.directory, `${currentReceipt.id}.json`))
    expect((await f.runtime.downloads.list({ workspaceId: f.workspace.id, browserId })).map(receipt => receipt.operationId)).toEqual(old.operationIds)
    await f.verify(current, 'unavailable')
    expect(f.runtime.contents.clicks).toBe(2)
    expect(await readFile(join(f.workspace.path, 'artifact.bin'))).toEqual(payload)
  }, 30_000)

  it.each(['foreign-browser', 'forged-reference'] as const)('refuses %s durable receipt facts through the real download owner and Manager', async invalid => {
    const f = await fixture(); f.install()
    const run = await f.run()
    const records = await f.runtime.downloads.list({ workspaceId: f.workspace.id, browserId })
    expect(records).toHaveLength(1)
    const path = join(f.directory, `${records[0]!.id}.json`), document = JSON.parse(await readFile(path, 'utf8'))
    if (invalid === 'foreign-browser') { document.receipt.browserId = 'browser-b'; document.receipt.reference.browserId = 'browser-b' }
    else document.receipt.reference.operationId = 'foreign-producer'
    await writeFile(path, JSON.stringify(document))
    await f.verify(run, 'unavailable')
    expect(f.runtime.contents.clicks).toBe(1)
    expect(await readFile(join(f.workspace.path, 'artifact.bin'))).toEqual(payload)
  }, 30_000)

  it('reports a real file revision/read failure as unavailable through Manager without another transfer', async () => {
    const f = await fixture(); f.install()
    const run = await f.run(); await f.verify(run, 'passed')
    await writeFile(join(f.workspace.path, 'artifact.bin'), Buffer.from([0, 255, 128, 1, 10, 14]))
    await f.verify(run, 'unavailable')
    expect(f.runtime.contents.clicks).toBe(1)
  }, 30_000)

  it('keeps publication with a failed metadata ACK unavailable through Manager while preserving the real binary and next healthy script', async () => {
    const f = await fixture(), publish = f.files.writeBytes.bind(f.files)
    vi.spyOn(f.files, 'writeBytes').mockImplementationOnce(async (...args) => {
      const result = await publish(...args)
      expect(result.status).toBe('written')
      const names = (await readdir(f.directory)).filter(name => name.endsWith('.json'))
      expect(names).toHaveLength(1)
      await rm(join(f.directory, names[0]!)); await mkdir(join(f.directory, names[0]!))
      return result
    })
    f.install(); const run = await f.run()
    expect(run.status).toBe('interrupted')
    const operation = await f.verify(run, 'unavailable')
    expect(operation.warning).toContain('unconfirmed')
    expect(await readFile(join(f.workspace.path, 'artifact.bin'))).toEqual(payload)
    expect((await f.runtime.manager.runScript(browserId, 'return 7')).outcome.kind).toBe('completed')
    expect(f.runtime.contents.clicks).toBe(1)
  }, 30_000)

  it('marks an actual unfinished owner record unavailable after Owner recreation; retained execution is inspected without redoing its click', async () => {
    const f = await fixture(); f.install(f.runtime, 'stop')
    const run = await f.run()
    expect(run.status).toBe('stopped'); expect(f.waitingMetadata).toHaveLength(1)
    const original = f.waitingMetadata[0]!
    await writeFile(join(f.directory, original.name), original.bytes)
    await writeFile(join(f.directory, original.name.replace(/\.json$/, '.part')), payload.subarray(0, 2))
    f.runtime.manager.dispose()
    const restored = await f.createRuntime()
    const records = await restored.downloads.list({ workspaceId: f.workspace.id, browserId })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'failed', operationId: run.operationIds[0] })
    expect(records[0]!.warning).toContain('unconfirmed'); expect(records[0]!.reference).toBeUndefined()
    await f.verify(run, 'unavailable', restored)
    expect(restored.contents.clicks).toBe(0); expect(f.runtime.contents.clicks).toBe(1)
  }, 30_000)
})
