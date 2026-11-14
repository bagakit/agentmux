// @vitest-environment happy-dom
import { importTaskRecording } from './helpers/import-task-recording.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ views: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false; contextId = 17
    attached = false; attaches = 0; detaches = 0; reads = 0
    beforeRead?: () => Promise<void>
    beforeLoad?: () => Promise<void>
    session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    mainFrame = { framesInSubtree: [] }
    debugger = Object.assign(new EventEmitter(), {
      attach: () => { if (this.attached) throw new Error('Already attached'); this.attached = true; this.attaches++ },
      detach: () => { this.attached = false; this.detaches++ },
      isAttached: () => this.attached,
      sendCommand: async (method: string, parameters: any = {}) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: this.contextId }
        if (method === 'Runtime.evaluate') return { result: parameters.expression === 'document'
          ? { objectId: 'actual-document' } : { value: document.URL } }
        if (method === 'Runtime.callFunctionOn') {
          if (parameters.functionDeclaration.includes('readStructuredDom')) { this.reads++; await this.beforeRead?.() }
          const value = Function(`return (${parameters.functionDeclaration})`)().call(document,
            ...(parameters.arguments ?? []).map((argument: any) => argument.value))
          return { result: { value } }
        }
        return {}
      }
    })
    isDestroyed() { return this.destroyed }
    isLoading() { return false }
    isBeingCaptured() { return false }
    isCurrentlyAudible() { return false }
    getURL() { return this.url }
    getTitle() { return 'Generic form' }
    getZoomFactor() { return 1 }
    setZoomFactor() {}
    disableDeviceEmulation() {}
    enableDeviceEmulation() {}
    setWindowOpenHandler() {}
    async executeJavaScriptInIsolatedWorld() { return true }
    async loadURL(url: string) {
      await this.beforeLoad?.()
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
      this.url = url; this.emit('did-navigate', {}, url); this.emit('did-finish-load'); this.emit('did-stop-loading')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class View {
    webContents = new Contents()
    constructor() { native.views.push(this) }
    setVisible() {}
    setBounds() {}
  }
  return { WebContentsView: View, app: { getPath: () => tmpdir() } }
})
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserOperationFileStore, BrowserOperationJournal } from '@agentmux/browser/browser-operation-journal'
import { BrowserStepEvidenceStore } from '@agentmux/browser/browser-step-evidence'
import { BrowserResultArtifactStore } from '@agentmux/browser/browser-result-artifact'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { BrowserTaskAssetFileStore, BrowserTaskAssets } from '../src/main/browser-task-assets'
import type { BrowserTaskAssetDocument } from '../src/shared/browser-task-assets'

const roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  native.views.length = 0
})
const unusedInput = { request: { fields: [{ key: 'result', type: 'string' as const, source: { selector: '#result', read: 'text' as const } }] },
  criteria: [{ kind: 'field-equals' as const, key: 'result', expected: 'ready' }] }
async function fixture(beforeTaskSave?: (value: BrowserTaskAssetDocument) => Promise<void>, retainedRoot?: string) {
  document.body.innerHTML = '<span id="result">ready</span>'
  const root = retainedRoot ?? await mkdtemp(join(tmpdir(), 'amux-outcome-manager-'))
  if (!retainedRoot) roots.push(root)
  const path = join(root, 'journal.json'), journalStore = new BrowserOperationFileStore(path), journal = new BrowserOperationJournal(journalStore)
  const taskPath = join(root, 'tasks.json'), taskStore = new BrowserTaskAssetFileStore(taskPath)
  const taskAssets = new BrowserTaskAssets({ load: () => taskStore.load(), save: async value => {
    await beforeTaskSave?.(value); await taskStore.save(value)
  } })
  const events: any[] = []
  const children: any[] = []
  const window = { contentView: { children, addChildView: (view: any) => children.push(view), removeChildView: (view: any) => children.splice(children.indexOf(view), 1) },
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
    isDestroyed: () => false, webContents: { isDestroyed: () => false, send(_channel: string, event: unknown) { events.push(structuredClone(event)) } } }
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private' },
    new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} },
    journal, new BrowserStepEvidenceStore(join(root, 'evidence')), new BrowserResultArtifactStore(join(root, 'results')), undefined, taskAssets,
    undefined, undefined, undefined, undefined, { preloadPath: join(root, 'preload.cjs') })
  managers.push(manager)
  await manager.create('browser-a', 'https://generic.invalid/form', 'workspace-a')
  return { root, manager, journal, journalStore, path, view: children[0], taskAssets, taskPath,
    browser: () => events.filter(event => event.type === 'updated').at(-1)?.browser }
}
import type { BrowserTaskStep, BrowserTaskCompletion, BrowserTaskParameter } from '../src/shared/browser-task-assets'
import { getBrowserTaskReliability } from '../src/shared/browser-task-reliability'
import { readBrowserOperationResult } from '@agentmux/browser/browser-operation-result'
import { projectBrowserControlResult } from '../src/main/browser-completion-control'
import { executeBrowserTaskControl } from '../src/main/browser-task-control'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt'
import { spawn } from 'node:child_process'

const url = 'https://generic.invalid/form'
const request = { fields: [
  { key: 'count', type: 'number' as const, source: { selector: '#count', read: 'text' as const } },
  { key: 'flag', type: 'boolean' as const, source: { selector: '#flag', read: 'checked' as const } },
  { key: 'empty', type: 'string' as const, source: { selector: '#empty', read: 'text' as const } }
] }
const extraction = (id = 'data'): BrowserTaskStep => ({ id, kind: 'extract', url, reviewed: true, extraction: structuredClone(request) })
const conditions = (stepId = 'data'): BrowserTaskCompletion => ({ criteria: [
  { kind: 'field-equals', stepId, key: 'count', expected: 0 },
  { kind: 'field-equals', stepId, key: 'flag', expected: false },
  { kind: 'field-equals', stepId, key: 'empty', expected: '' }
] })
function page() { document.body.innerHTML = '<span id="count">0</span><input id="flag" type="checkbox"><span id="empty"></span>' }
async function save(f: Awaited<ReturnType<typeof fixture>>, steps = [extraction()], completion = conditions(), parameters: BrowserTaskParameter[] = []) {
  const imported = await importTaskRecording(f.taskAssets, { id: 'recording', browserId: 'browser-a', navigationId: 'recorded-nav', url,
    status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await f.taskAssets.edit(imported.id, imported.revision, { ...imported.draft, steps, parameters, completion })
  return await f.taskAssets.saveVersion(edited.id, edited.revision)
}
async function durableTexts(root: string): Promise<string> {
  let text = ''
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) text += await durableTexts(path)
    else text += await readFile(path, 'utf8')
  }
  return text
}

describe('saved task extraction uses the original producer, artifact and recorded outcome owners', () => {
  it('pre-registers the exact immutable schema, preserves 0/false/empty and reads original bytes without another page program', async () => {
    const f = await fixture(); page()
    const asset = await save(f)
    let before: any
    f.view.webContents.beforeRead = async () => { before = (await new BrowserOperationFileStore(f.path).load())!.operations.at(-1) }
    const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    expect(run.status).toBe('completed')
    expect(before.outcome.registration).toMatchObject({ assetRun: { runId: run.id, assetId: asset.id, version: 1 } })
    expect(before.outcome.registration.criteria.map((item: any) => item.producer)).toEqual(request.fields.map(() => ({ operationId: before.id, navigationId: before.outcome.registration.context.navigationId, sequence: 1, request })))
    const inspected = await f.manager.inspectTaskRun('browser-a', run.id)
    expect(inspected?.completions[0]?.status).toBe('passed')
    const read = await readBrowserOperationResult(run.operationIds[0]!, { sequence: 1, maxBytes: 65536 }, f.manager)
    expect(read.resultRead.status).toBe('available')
    const captured = JSON.parse(Buffer.from(read.resultRead.chunk!.data, 'base64').toString('utf8'))
    expect(captured.fields.map((field: any) => field.value)).toEqual([0, false, ''])
    const evidence = await f.manager.getStepEvidence(run.operationIds[0]!, 1)
    expect(JSON.stringify(evidence)).not.toContain('"value":')
    expect(f.view.webContents.reads).toBe(1)
    const state = await f.manager.getTaskAssets('browser-a')
    expect(state.completion?.status).toBe('passed')
    expect(getBrowserTaskReliability({ browserId: 'browser-a', assetId: asset.id, version: 1, state, operations: await f.journal.list() }).counts.passed).toBe(1)
  })

  it('aggregates exact historical producers across a navigation and trusted checkpoint, never just the first passed field', async () => {
    const f = await fixture(); page()
    const second = extraction('second')
    second.url = 'https://generic.invalid/next'
    const completion: BrowserTaskCompletion = { criteria: [
      { kind: 'field-equals', stepId: 'data', key: 'count', expected: 0 },
      { kind: 'human-checkpoint', checkpointId: 'person' },
      { kind: 'field-equals', stepId: 'second', key: 'flag', expected: true }
    ] }
    const asset = await save(f, [extraction(), { id: 'person', kind: 'checkpoint', url, reviewed: true },
      { id: 'next', kind: 'navigate', url: second.url, reviewed: true }, second], completion)
    const waiting = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    expect(waiting.status).toBe('waiting-human')
    const finished = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, runId: waiting.id, parameters: {} })
    expect(finished.status).toBe('completed')
    const summary = (await f.manager.inspectTaskRun('browser-a', finished.id))!.completions[0]!
    expect(summary.status).toBe('not-met')
    expect(summary.conditions.map(item => item.status)).toEqual(['passed', 'passed', 'not-met'])
    expect(new Set(summary.conditions.flatMap(item => item.operationId ?? [])).size).toBe(2)
    expect(f.view.webContents.reads).toBe(2)
    const prior = await f.manager.verifyOutcome('browser-a', finished.operationIds[0]!)
    expect(prior.status).toBe('unavailable') // Current-document verification is still strict.
    expect(f.view.webContents.reads).toBe(2)
  })

  it('keeps fixed-version data after later edits, owner rebuild and a missing result; inspection never replays extraction', async () => {
    const f = await fixture(); page(); const asset = await save(f)
    const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    const edited = await f.taskAssets.edit(asset.id, asset.revision, { ...asset.draft, name: 'v2', completion: { criteria: [{ kind: 'field-equals', stepId: 'data', key: 'count', expected: 99 }] } })
    await f.taskAssets.saveVersion(edited.id, edited.revision)
    const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
    Object.assign(manager, { taskAssets: new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.taskPath)),
      operationJournal: new BrowserOperationJournal(new BrowserOperationFileStore(f.path)), entries: new Map() })
    const restored = await manager.inspectTaskRun('browser-a', run.id)
    expect(restored?.completions[0]).toMatchObject({ runId: run.id, version: 1, status: 'passed' })
    const original = await f.manager.readStepResult(run.operationIds[0]!, 1)
    await rm(join(f.root, 'results', original.reference.id + '.data'))
    const missing = await readBrowserOperationResult(run.operationIds[0]!, { sequence: 1 }, f.manager)
    expect(missing.resultRead.status).toBe('unavailable')
    expect(missing.runOperation?.id).toBe(run.operationIds[0])
    expect(f.view.webContents.reads).toBe(1)
    expect((await manager.inspectTaskRun('browser-a', run.id))!.completions[0]!.status).toBe('passed') // Recorded check, not today's retention/readability.
  })

  it('allows explicit data on a private invocation while withholding fresh secrets and their selected echo before artifact persistence', async () => {
    const f = await fixture(); page(); const secret = 'fresh-private-🙂-"quote"-\\path\n17382'
    const asset = await save(f, [extraction()], conditions(), [{ key: 'password', label: 'Password', secret: true }])
    const first = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: { password: secret } })
    expect((await f.manager.inspectTaskRun('browser-a', first.id))!.completions[0]!.status).toBe('passed')
    expect(await durableTexts(f.root)).not.toContain(secret)
    document.querySelector('#empty')!.textContent = secret
    const second = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: { password: secret } })
    expect(second.status).toBe('interrupted') // Original warning/unknown contract; no automatic extraction replay.
    expect((await f.manager.inspectTaskRun('browser-a', second.id))!.completions[0]!.status).toBe('unavailable')
    expect(await durableTexts(f.root)).not.toContain(secret)
    expect((await readdir(join(f.root, 'results'))).filter(name => name.endsWith('.data'))).toHaveLength(1)
    expect(f.view.webContents.reads).toBe(2)
  })

  it('reports missing/type-error as not-met and ambiguous or truncated fields as unavailable', async () => {
    const f = await fixture(); page(); const asset = await save(f)
    document.querySelector('#count')!.textContent = 'not a number'
    const mismatch = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    expect((await f.manager.inspectTaskRun('browser-a', mismatch.id))!.completions[0]!.status).toBe('not-met')
    document.querySelector('#count')!.textContent = '0'
    document.body.insertAdjacentHTML('beforeend', '<span id="count">0</span>')
    const ambiguous = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    expect((await f.manager.inspectTaskRun('browser-a', ambiguous.id))!.completions[0]!.status).toBe('unavailable')
    expect(f.view.webContents.reads).toBe(2)
  })

  it('refuses ephemeral saved refs and a field expectation of the wrong type without page work', async () => {
    const f = await fixture(); page()
    await expect(save(f, [{ ...extraction(), extraction: { ...request, withinRef: '@e7' } as any }])).rejects.toThrow()
    await expect(save(f, [extraction()], { criteria: [{ kind: 'field-equals', stepId: 'data', key: 'count', expected: '0' }] })).rejects.toThrow('declared type')
    expect(f.view.webContents.reads).toBe(0)
  })
})

async function publicCli(root: string, args: string[], stdin = '') {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/core/dist/agentmux.js'), 'browser', ...args], {
      env: objectCliEnvironment(root), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error('The private public CLI did not finish.')) }, 20_000)
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timeout); done({ code: code ?? -1, stdout, stderr }) })
    child.stdin.on('error', () => {}); child.stdin.end(stdin)
  })
}
it('actual built CLI consumes original task edit/publish/run/inspect and reads the same retained bytes through browser inspect', async () => {
  const f = await fixture(); page()
  const asset = await save(f)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [], execute: async request => {
    if (request.operation === 'browser.operation') {
      if (request.resultRead) return projectBrowserControlResult({ operation: request.operation, ...await readBrowserOperationResult(request.operationId, request.resultRead, f.manager) })
      return projectBrowserControlResult({ operation: request.operation, runOperation: await f.manager.getOperation(request.operationId) })
    }
    return await executeBrowserTaskControl(request, f.manager, true)
  } })
  await server.start()
  try {
    const input = join(f.root, 'definition.json')
    await writeFile(input, JSON.stringify({ ...asset.draft, name: 'CLI data task' }))
    const edited = await publicCli(f.root, ['task', 'edit', '--browser', 'browser-a', '--asset', asset.id, '--expected-revision', String(asset.revision), '--input', input])
    expect(edited.code, edited.stderr).toBe(0)
    const revision = (objectCliReceipt(JSON.parse(edited.stdout)) as any).result.asset.revision
    const published = await publicCli(f.root, ['task', 'publish', '--browser', 'browser-a', '--asset', asset.id, '--expected-revision', String(revision)])
    expect(published.code, published.stderr).toBe(0)
    const version = (objectCliReceipt(JSON.parse(published.stdout)) as any).result.publishedVersion
    await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} }) // Explicit trusted Run, never a CLI approval.
    const executed = await publicCli(f.root, ['task', 'run', '--browser', 'browser-a', '--asset', asset.id, '--version', String(version)], '{}')
    expect(executed.code, executed.stderr).toBe(0)
    const run = (objectCliReceipt(JSON.parse(executed.stdout)) as any).result.run
    const inspection = await publicCli(f.root, ['task', 'inspect', '--browser', 'browser-a', '--run', run.id])
    expect(inspection.code, inspection.stderr).toBe(0)
    expect((objectCliReceipt(JSON.parse(inspection.stdout)) as any).result.inspection.completions[0]).toMatchObject({ runId: run.id, version, status: 'passed' })
    const read = await publicCli(f.root, ['inspect', '--operation-id', run.operationIds[0], '--step', '1', '--max-bytes', '128'])
    expect(read.code, read.stderr).toBe(0)
    const receipt = (objectCliReceipt(JSON.parse(read.stdout)) as any).result
    expect(receipt.resultRead).toMatchObject({ sequence: 1, status: 'available', chunk: { offset: 0, returnedBytes: 128, nextOffset: 128 } })
    expect(receipt.runOperation.completion.status).toBe('passed')
    expect(f.view.webContents.reads).toBe(2)
    const wrong = await publicCli(f.root, ['inspect', '--operation-id', run.operationIds[0], '--step', '2'])
    expect(wrong.code, wrong.stderr).toBe(0)
    expect((objectCliReceipt(JSON.parse(wrong.stdout)) as any).result).toMatchObject({ runOperation: { id: run.operationIds[0] }, resultRead: { status: 'not-recorded' } })
  } finally { await server.stop() }
}, 90_000)

it('a cursor write refusal prevents only this extraction, while the original Browser still executes healthy work', async () => {
  let fail = false
  const f = await fixture(async value => { if (fail && value.runs.some(run => run.status === 'running')) throw new Error('synthetic storage unavailable') })
  page(); const asset = await save(f); fail = true
  await expect(f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })).rejects.toThrow('could not be saved')
  expect(f.view.webContents.reads).toBe(0)
  expect(f.view.webContents.isDestroyed()).toBe(false)
  fail = false
  expect((await f.manager.runScript('browser-a', 'return 42')).outcome.kind).toBe('completed')
})

it('a late read failure and a selected password input do not become successful data or replay another extraction', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  f.view.webContents.beforeRead = async () => { throw new Error('synthetic-private-error-text') }
  const interrupted = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  expect(interrupted.status).toBe('interrupted')
  expect((await f.manager.inspectTaskRun('browser-a', interrupted.id))!.completions[0]!.status).toBe('unavailable')
  expect(f.view.webContents.reads).toBe(1)
  expect(await durableTexts(f.root)).not.toContain('synthetic-private-error-text')
  f.view.webContents.beforeRead = undefined
  const password = extraction('password-field')
  password.extraction = { fields: [{ key: 'private-input', type: 'string', source: { selector: '#secret', read: 'value' } }] }
  document.body.insertAdjacentHTML('beforeend', '<input type="password" id="secret" value="private-only-password">')
  const second = await save(f, [password], { criteria: [{ kind: 'field-equals', stepId: password.id, key: 'private-input', expected: '' }] })
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: second.id, version: 1, parameters: {} })
  expect((await f.manager.inspectTaskRun('browser-a', run.id))!.completions[0]!.status).toBe('unavailable')
  expect(await durableTexts(f.root)).not.toContain('private-only-password')
  const metadata = { ...password, id: 'password-metadata', extraction: { fields: [{ key: 'input-type', type: 'string' as const, source: { selector: '#secret', read: 'attribute' as const, attribute: 'type' } }] } }
  const readable = await save(f, [metadata], { criteria: [{ kind: 'field-equals', stepId: metadata.id, key: 'input-type', expected: 'password' }] })
  const metadataRun = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: readable.id, version: 1, parameters: {} })
  expect((await f.manager.inspectTaskRun('browser-a', metadataRun.id))!.completions[0]!.status).toBe('passed')
})

it('joins a fixed subflow child extraction to that child run without borrowing the root selected run or re-executing its item', async () => {
  const f = await fixture(); page(); const child = await save(f)
  const imported = await importTaskRecording(f.taskAssets, { id: 'root-source', browserId: 'browser-a', navigationId: 'root-recorded', url,
    status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
  const draft = await f.taskAssets.edit(imported.id, imported.revision, { ...imported.draft, steps: [{ id: 'call', kind: 'subflow', url, reviewed: true,
    subflow: { target: { kind: 'local', assetId: child.id, version: 1 }, iteration: 'once' } }] })
  const root = await f.taskAssets.saveVersion(draft.id, draft.revision)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: root.id, version: 1, parameters: {}, calls: { call: { parameters: {}, items: [{ id: 'one', parameters: {} }] } } })
  expect(run.status).toBe('completed')
  const inspection = (await f.manager.inspectTaskRun('browser-a', run.id))!
  expect(inspection.completions).toHaveLength(1)
  expect(inspection.completions[0]).toMatchObject({ assetId: child.id, version: 1, status: 'passed' })
  expect(inspection.completions[0]!.runId).not.toBe(run.id)
  expect(f.view.webContents.reads).toBe(1)
})

import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import { BrowserTaskExtractEditor } from '../src/renderer/src/components/BrowserTaskExtractEditor'
import { BrowserStructuredFields } from '../src/renderer/src/components/BrowserStructuredFields'
import type { BrowserTaskContent } from '../src/shared/browser-task-assets'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

async function mountData(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
it('the real Editor creates a saved extraction schema with a zero condition and keeps the original immutable version separate', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const onSave = vi.fn(async (_draft: BrowserTaskContent) => {})
  const mounted = await mountData(createElement(BrowserTaskAssetEditor, { asset, recording: null, onImport() {}, onSaveDraft: onSave, onSaveVersion: onSave,
    onLocateStep() {}, onRun: async () => {}, onStop() {} }))
  try {
    const add = Array.from(mounted.host.querySelectorAll('button')).find(button => button.textContent === 'Add extraction')!
    await act(async () => add.click())
    expect(mounted.host.querySelectorAll('.browser-task-extract')).toHaveLength(2)
    const latest = mounted.host.querySelectorAll('.browser-task-extract')[1]!
    const selector = latest.querySelector<HTMLInputElement>('input[aria-label="Extraction field 1 selector"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(selector, '#count'); selector.dispatchEvent(new Event('input', { bubbles: true })) })
    const type = latest.querySelector<HTMLSelectElement>('select[aria-label="Extraction field 1 type"]')!
    await act(async () => { type.value = 'number'; type.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => latest.querySelector<HTMLInputElement>('input[aria-label="Require extraction field 1"]')!.click())
    await act(async () => Array.from(mounted.host.querySelectorAll('button')).find(button => button.textContent === 'Save draft')!.click())
    const saved = onSave.mock.calls[0]![0]
    expect(saved.steps.at(-1)?.kind).toBe('extract')
    expect(saved.steps.at(-1)?.extraction?.fields[0]).toMatchObject({ key: 'result', type: 'number', source: { selector: '#count', read: 'text' } })
    expect(saved.completion?.criteria.at(-1)).toMatchObject({ kind: 'field-equals', expected: 0, stepId: saved.steps.at(-1)!.id })
    expect(asset.versions[0]!.steps).toHaveLength(1)
  } finally { await mounted.close() }
})

it('changing a field identity removes only its old condition in one original Editor update', async () => {
  const step = extraction(), criteria = conditions().criteria, update = vi.fn()
  const mounted = await mountData(createElement(BrowserTaskExtractEditor, { step, criteria, busy: false, onChange: update, onCriteria: vi.fn() }))
  try {
    const type = mounted.host.querySelector<HTMLSelectElement>('select[aria-label="Extraction field 1 type"]')!
    await act(async () => { type.value = 'string'; type.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0]).toMatchObject({ reviewed: false, extraction: { fields: [{ key: 'count', type: 'string' }, { key: 'flag' }, { key: 'empty' }] } })
    expect(update.mock.calls[0]![1]).toEqual(criteria.filter(item => item.kind !== 'field-equals' || item.key !== 'count'))
  } finally { await mounted.close() }
})

it('the original structured-fields viewer explicitly reads the retained JSON and never recaptures the page', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const evidence = await f.manager.getStepEvidence(run.operationIds[0]!, 1)
  const item = evidence.items.find(item => item.content.kind === 'structured-output')!
  if (item.content.kind !== 'structured-output') throw new Error('Missing actual structured evidence')
  const read = vi.fn(async (_reference, options) => f.manager.readStepResult(run.operationIds[0]!, 1, options))
  const mounted = await mountData(createElement(BrowserStructuredFields, { receipt: item.content.receipt, readResult: read }))
  try {
    expect(mounted.host.textContent).toContain('Saved in recorded JSON')
    expect(read).not.toHaveBeenCalled()
    const details = Array.from(mounted.host.querySelectorAll('details')).find(details => details.querySelector('summary')?.textContent === 'Recorded JSON')!
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); await new Promise(done => setTimeout(done, 30)) })
    expect(read).toHaveBeenCalledTimes(1)
    expect(mounted.host.querySelector('pre')?.textContent).toContain('"value":0')
    expect(mounted.host.querySelector('pre')?.textContent).toContain('"value":false')
    expect(f.view.webContents.reads).toBe(1)
  } finally { await mounted.close() }
})

import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
it('the actual public result codec keeps the original operation when an optional artifact is foreign or corrupted', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const read = projectBrowserControlResult({ operation: 'browser.operation', ...await readBrowserOperationResult(run.operationIds[0]!, { sequence: 1 }, f.manager) })
  if (read.operation !== 'browser.operation') throw new Error('Missing actual operation projection')
  const { operation: _operation, ...body } = read
  const foreign = structuredClone(body)
  foreign.resultRead!.chunk!.reference.operationId = 'another-original-operation'
  const consumed = parseRpcControlResult('browser.inspect', foreign, { operationId: run.operationIds[0], resultRead: { sequence: 1 } }) as any
  expect(consumed.runOperation.id).toBe(run.operationIds[0])
  expect(consumed.runOperation.completion.status).toBe('passed')
  expect(consumed.resultRead.status).toBe('unavailable')
  expect(f.view.webContents.reads).toBe(1)
})

import { getBrowserTaskRunCompletion } from '../src/shared/browser-task-reliability'
import type { BrowserOperation } from '@agentmux/browser/model/browser-operation'
it('recorded aggregation rejects a same-value producer attributed to another version of this original run', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const operations = await f.journal.list(), borrowed = structuredClone(operations)
  for (const operation of borrowed) if (operation.outcome) {
    operation.outcome.registration.assetRun!.version = 2
    operation.outcome.evaluation!.assetRun!.version = 2
  }
  expect(getBrowserTaskRunCompletion(run, asset.versions[0]!, borrowed)?.status).toBe('unavailable')
  expect(getBrowserTaskRunCompletion(run, asset.versions[0]!, operations)?.status).toBe('passed')
})

it('the original aggregate requires every field, recorded download and exact trusted checkpoint, including an unavailable later producer', async () => {
  // The extraction is a real manager/Journal/artifact call. The extra download records here
  // are explicit facts for the pure aggregate, not a claim of native DownloadItem coverage.
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const operation = (await f.manager.getOperation(run.operationIds[0]!))!
  const version = structuredClone(asset.versions[0]!)
  version.steps.push({ id: 'file', kind: 'click', url, reviewed: true }, { id: 'confirmed', kind: 'checkpoint', url, reviewed: true })
  version.completion!.criteria.push({ kind: 'download-readable', stepId: 'file', path: 'report.json' }, { kind: 'human-checkpoint', checkpointId: 'confirmed' })
  const fileId = 'recorded-file-operation', context = { ...operation.outcome!.registration.context, operationId: fileId }
  const owner = { runId: run.id, assetId: asset.id, version: 1 }
  const criteria = [{ kind: 'download-readable' as const, path: 'report.json', producer: { operationId: fileId, navigationId: context.navigationId } }, { kind: 'human-checkpoint' as const, checkpointId: 'confirmed' }]
  const file: BrowserOperation = { id: fileId, browserId: 'browser-a', operator: { id: 'person', name: 'Person' }, startedAt: 1, finishedAt: 2,
    phase: 'completed', summary: 'Recorded file', url, steps: [{ sequence: 1, method: 'download', label: 'Download', startedAt: 1, finishedAt: 2, status: 'completed' }],
    outcome: { registration: { context, assetRun: owner, criteria }, evaluation: { context, assetRun: owner, status: 'passed', conditions: [
      { criterion: { kind: 'download-readable', path: 'report.json' }, status: 'passed', reason: 'Original readable revision.' },
      { criterion: { kind: 'human-checkpoint', checkpointId: 'confirmed' }, status: 'passed', reason: 'Original trusted Continue.' }
    ] } } }
  const completed = { ...run, nextStep: 3, operationIds: [...run.operationIds, fileId], stepExecutions: [...run.stepExecutions!, { stepId: 'file', operationId: fileId }],
    humanCheckpoints: [{ ...owner, browserId: 'browser-a', checkpointId: 'confirmed', pendingCursor: 3, origin: 'trusted-ui' as const, controlBefore: 'human' as const, confirmedAt: 1 }] }
  expect(getBrowserTaskRunCompletion(completed, version, [operation, file])?.conditions.map(item => item.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed'])
  file.outcome!.evaluation!.status = 'unavailable'; file.outcome!.evaluation!.conditions[0]!.status = 'unavailable'
  expect(getBrowserTaskRunCompletion(completed, version, [operation, file])?.status).toBe('unavailable')
  expect(getBrowserTaskRunCompletion({ ...completed, humanCheckpoints: [] }, version, [operation, file])?.conditions.at(-1)?.status).toBe('not-met')
})

import { parseBrowserTaskControlResult } from '../../../packages/core/src/browser-task-control'
it('a malformed optional completion leaves the original public run tree and precise unknown item readable', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const inspection = (await f.manager.inspectTaskRun('browser-a', run.id))!
  const bad = structuredClone(inspection); bad.completions[0]!.status = 'fabricated' as any
  const consumed = parseBrowserTaskControlResult('browser.task.inspect', { inspection: bad })
  if (consumed.operation !== 'browser.task.inspect') throw new Error('Wrong original task read')
  expect(consumed.inspection?.runs.map(run => run.id)).toEqual(inspection.runs.map(run => run.id))
  expect(consumed.inspection?.completions?.[0]).toMatchObject({ runId: run.id, status: 'unavailable', conditions: [] })
  expect(consumed.inspection?.warning).toContain('unavailable')
  const missing = parseBrowserTaskControlResult('browser.task.inspect', { inspection: { ...inspection, completions: null } })
  if (missing.operation !== 'browser.task.inspect') throw new Error('Wrong original task read')
  expect(missing.inspection?.runs[0]?.id).toBe(run.id)
  expect(missing.inspection?.warning).toContain('unavailable')
  expect(f.view.webContents.reads).toBe(1)
})

it('known-secret type failures and a truncated secret prefix do not persist actual values or previews', async () => {
  const f = await fixture(); page()
  const secret = 'private-typed-token-'.repeat(10)
  const asset = await save(f, [extraction()], conditions(), [{ key: 'private', label: 'Private', secret: true }])
  document.querySelector('#count')!.textContent = secret
  const typed = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: { private: secret } })
  expect((await f.manager.inspectTaskRun('browser-a', typed.id))!.completions[0]!.status).toBe('unavailable')
  expect(await durableTexts(f.root)).not.toContain(secret)
  const prefix = secret.slice(0, 8)
  document.querySelector('#count')!.textContent = 'x'.repeat(16372) + secret
  const partial = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: { private: secret } })
  const read = await f.manager.readStepResult(partial.operationIds[0]!, 1, { maxBytes: 65536 })
  const captured = JSON.parse(Buffer.from(read.data, 'base64').toString('utf8'))
  expect(captured.fields[0]).toMatchObject({ status: 'truncated' })
  expect(captured.fields[0]).not.toHaveProperty('preview')
  expect(await durableTexts(f.root)).not.toContain(prefix)
  expect((await f.manager.inspectTaskRun('browser-a', partial.id))!.completions[0]!.status).toBe('unavailable')
})

it('the original viewer does not label withheld data as a saved JSON result', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const evidence = await f.manager.getStepEvidence(run.operationIds[0]!, 1)
  const item = evidence.items.find(item => item.content.kind === 'structured-output')!
  if (item.content.kind !== 'structured-output') throw new Error('Missing actual extraction evidence')
  const { artifact: _artifact, ...source } = item.content.receipt
  const mounted = await mountData(createElement(BrowserStructuredFields, { receipt: { ...source, artifactStatus: 'unavailable', warning: 'Result save unconfirmed.' } }))
  try {
    expect(mounted.host.textContent).toContain('Value was not saved')
    expect(mounted.host.textContent).not.toContain('Saved in recorded JSON')
    expect(Array.from(mounted.host.querySelectorAll('summary')).some(summary => summary.textContent === 'Recorded JSON')).toBe(false)
  } finally { await mounted.close() }
})

import { StandaloneBrowserHost } from '@agentmux/browser/browser-standalone-host'
it('the original standalone inspect dispatch keeps its operation when a retained step read is unavailable, without a page program', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const operation = (await f.manager.getOperation(run.operationIds[0]!))!
  const readStepResult = vi.fn(async () => { throw new Error('Original artifact currently unavailable') })
  const runScript = vi.fn()
  const host = Object.create(StandaloneBrowserHost.prototype) as StandaloneBrowserHost
  Object.assign(host, { ready: async () => {}, journal: { get: async () => operation }, programs: { readStepResult, runScript } })
  const result = await host.execute({ schemaVersion: 5, requestId: 'standalone-read', operation: 'browser.operation', operationId: operation.id, resultRead: { sequence: 1 } })
  expect(result).toMatchObject({ operation: 'browser.operation', runOperation: { id: operation.id }, resultRead: { status: 'unavailable', sequence: 1 } })
  expect(readStepResult).toHaveBeenCalledTimes(1)
  expect(runScript).not.toHaveBeenCalled()
  expect(f.view.webContents.reads).toBe(1)
})

it('step-two malformed optional result observations never borrow sequence one or hide the original public operation', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const projected = projectBrowserControlResult({ operation: 'browser.operation', runOperation: await f.manager.getOperation(run.operationIds[0]!) })
  if (projected.operation !== 'browser.operation') throw new Error('Wrong original operation')
  for (const resultRead of [undefined, { status: 'available' }, { sequence: -1, status: 'available' }, { sequence: 'two', status: 'unavailable' },
    { sequence: 1, status: 'available' }, { sequence: 1, status: 'available', chunk: { malformed: true } }]) {
    const consumed = parseRpcControlResult('browser.inspect', { runOperation: projected.runOperation, ...(resultRead === undefined ? {} : { resultRead }) },
      { operationId: run.operationIds[0], resultRead: { sequence: 2 } }) as any
    expect(consumed.runOperation.id).toBe(run.operationIds[0])
    expect(consumed.resultRead).toMatchObject({ status: 'unavailable', sequence: null })
    expect(consumed.resultRead).not.toHaveProperty('chunk')
  }
  const good = await readBrowserOperationResult(run.operationIds[0]!, { sequence: 1 }, f.manager)
  expect(() => parseRpcControlResult('browser.inspect', { runOperation: projected.runOperation, resultRead: good.resultRead },
    { operationId: run.operationIds[0], resultRead: { sequence: 2 } })).toThrow('another target')
  expect(f.view.webContents.reads).toBe(1)
})

it('an unconfirmed checked save stays unavailable and an explicit same-document verification restores the original outcome without extraction replay', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  let fail = true
  const actualSave = f.journalStore.save.bind(f.journalStore)
  vi.spyOn(f.journalStore, 'save').mockImplementation(async changes => {
    if (fail && changes.operations.some(operation => operation.metadata.outcome?.evaluation)) throw new Error('Synthetic checked-save failure')
    return await actualSave(changes)
  })
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  expect(run.status).toBe('completed')
  expect((await f.manager.inspectTaskRun('browser-a', run.id))!.completions[0]!.status).toBe('unavailable')
  fail = false
  expect((await f.manager.verifyOutcome('browser-a', run.operationIds[0]!)).status).toBe('passed')
  expect((await f.manager.inspectTaskRun('browser-a', run.id))!.completions[0]!.status).toBe('passed')
  expect(f.view.webContents.reads).toBe(1)
})


import { BrowserProgramOwner } from '@agentmux/browser/browser-program-owner'
it('reads the exact retained artifact after a real native release and cold owner rebuild without creating or attaching a page', async () => {
  const f = await fixture(); page(); const asset = await save(f)
  const run = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
  const original = await f.manager.readStepResult(run.operationIds[0]!, 1, { maxBytes: 65536 })
  expect(f.view.webContents.reads).toBe(1)
  f.manager.dispose()
  const restored = await fixture(undefined, f.root)
  const current = restored.browser()
  const release = await restored.manager.release('browser-a', current.navigationId)
  expect(release).toMatchObject({ status: 'released', browserId: 'browser-a' })
  expect(restored.view.webContents.destroyed).toBe(true)
  const viewsBefore = native.views.length
  const read = await readBrowserOperationResult(run.operationIds[0]!, { sequence: 1, maxBytes: 65536 }, restored.manager)
  expect(read.resultRead.status).toBe('available')
  expect(read.resultRead.chunk?.data).toBe(original.data)
  expect(read.runOperation?.id).toBe(run.operationIds[0])
  expect(native.views.length).toBe(viewsBefore)
  expect(restored.view.webContents.reads).toBe(0)
  const requireLive = vi.fn(() => { throw new Error('No live Browser binding') })
  const attach = vi.fn()
  const programs = new BrowserProgramOwner({ require: requireLive, attach } as never, {
    journal: new BrowserOperationJournal(new BrowserOperationFileStore(f.path)),
    evidence: new BrowserStepEvidenceStore(join(f.root, 'evidence')),
    results: new BrowserResultArtifactStore(join(f.root, 'results'))
  } as never)
  const external = await programs.readStepResult(run.operationIds[0]!, 1, { maxBytes: 65536 })
  expect(external.data).toBe(original.data)
  expect(requireLive).not.toHaveBeenCalled()
  expect(attach).not.toHaveBeenCalled()
  expect(native.views.length).toBe(viewsBefore)
})
