// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { AgentMuxControlServer, parseAgentMuxControlRequest } from '../../../packages/core/src/control-host.js'
import { browserTaskCreateInput, parseBrowserTaskControlResult, assertBrowserTaskControlTarget } from '../../../packages/core/src/browser-task-control.js'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import { BrowserDemonstrationRecorder, BrowserDemonstrationFileStore } from '../src/main/browser-demonstration-recorder.js'
import { executeBrowserTaskControl } from '../src/main/browser-task-control.js'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'

const browserId = 'original-browser', url = 'https://generic.invalid/form', sentinel = 'private-source-body-sentinel', flags = ['--browser', browserId]
const directories: string[] = []
let processBundle: string
beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-public-create-code-')); directories.push(directory)
  await build({ configFile: false, logLevel: 'silent', build: { ssr: true, minify: false, emptyOutDir: false, outDir: directory,
    rollupOptions: { input: resolve('apps/desktop/test/fixtures/browser-task-create-process.ts'), external: id => !id.startsWith('.') && !id.startsWith('/'), output: { format: 'es', entryFileNames: 'process.mjs' } } } })
  await symlink(resolve('apps/desktop/node_modules'), join(directory, 'node_modules')); processBundle = join(directory, 'process.mjs')
})
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))) })
afterEach(() => vi.restoreAllMocks())
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-public-create-')); directories.push(directory)
  const assetPath = join(directory, 'assets.json'), sourcePath = join(directory, 'recordings.json'), sourceDisk = new BrowserDemonstrationFileStore(sourcePath)
  await sourceDisk.save({ version: 1, drafts: [{ id: 'original-recording', browserId, navigationId: 'original-navigation', url, revision: 2, status: 'stopped', startedAt: 1, updatedAt: 2,
    steps: [{ id: 'original-fill', sequence: 1, navigationId: 'original-navigation', recordedAt: 2, source: 'native-human', method: 'fillInput', url, target: { role: 'text input', name: 'Field', ordinal: 1, count: 1 }, inputKey: 'fresh', args: [] }], warning: sentinel }] })
  const disk = new BrowserTaskAssetFileStore(assetPath); let fault: 'before' | 'after' | undefined, loseReply = false
  const store: BrowserTaskAssetStore = { load: () => disk.load(), save: async value => { if (fault === 'before') throw Error('Private storage failure'); await disk.save(value); if (fault === 'after') throw Error('Private storage reply lost') } }
  const assets = new BrowserTaskAssets(store), recorder = new BrowserDemonstrationRecorder(sourceDisk), manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  const view = { webContents: { isDestroyed: () => false } }, entry = { id: browserId, view }
  Object.assign(manager, { taskAssets: assets, demonstrations: recorder, entries: new Map([[browserId, entry]]) }); vi.spyOn(manager as any, 'emit').mockImplementation(() => {})
  const automation = vi.fn(async () => { throw Error('Page execution is disabled') }), createPage = vi.spyOn(manager, 'create'), restorePage = vi.spyOn(manager, 'restore'), runPage = vi.spyOn(manager, 'runScript')
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: async request => {
    const result = await executeBrowserTaskControl(request, manager, automation)
    if (request.operation === 'browser.task.create' && loseReply) { loseReply = false; throw Error('Private reply unavailable after the original owner returned') }
    return result
  } }); await server.start()
  const input = browserTaskCreateInput((await recorder.get(browserId))!), inputPath = join(directory, 'input.json'); await writeFile(inputPath, JSON.stringify(input))
  return { directory, assetPath, sourcePath, inputPath, input, assets, recorder, manager, disk, server, automation, createPage, restorePage, runPage,
    setFault: (next: typeof fault) => { fault = next }, loseReply: () => { loseReply = true } }
}
async function processRun(executable: string, args: string[], env?: NodeJS.ProcessEnv, input = '') {
  return new Promise<{ code: number; stdout: string; stderr: string; pid: number }>((accept, reject) => {
    const child = spawn(executable, args, { cwd: resolve('.'), env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('Private public caller did not finish')) }, 15_000)
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value }); child.stderr.setEncoding('utf8').on('data', value => { stderr += value }); child.stdin.on('error', () => {})
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); accept({ code: code ?? -1, stdout, stderr, pid: child.pid! }) }); child.stdin.end(input)
  })
}
const cli = (f: Awaited<ReturnType<typeof fixture>>, args: string[], input = '') => processRun(process.execPath, [resolve('packages/core/dist/agentmux.js'), 'browser', 'task', ...args], objectCliEnvironment(f.directory), input)
const result = (stdout: string) => objectCliReceipt(JSON.parse(stdout)).result as any

it('compiled CLI → public RPC → Main discovers and creates one unreviewed original draft, then checks across a real process restart', async () => {
  const f = await fixture()
  Object.assign(f.manager, { entries: new Map() }) // Metadata never restores or creates a native page.
  try {
    const source = await cli(f, ['source', ...flags]); expect(source.code, source.stderr).toBe(0)
    expect(result(source.stdout)).toMatchObject({ source: { id: f.input.sourceRecordingId, browserId, revision: f.input.sourceRevision, status: 'stopped', stepCount: 1 } })
    for (const absent of [sentinel, 'steps', 'navigationId', 'args']) expect(source.stdout).not.toContain(absent)
    f.input = browserTaskCreateInput(result(source.stdout).source)
    await writeFile(f.inputPath, JSON.stringify(f.input))
    const created = await cli(f, ['create', ...flags, '--input', f.inputPath]); expect(created.code, created.stderr).toBe(0)
    expect(result(created.stdout)).toEqual({ creation: { assetId: f.input.assetId, browserId, status: 'created', createOperationId: f.input.createOperationId } })
    const draft = await cli(f, ['draft', ...flags, '--asset', f.input.assetId]); expect(draft.code, draft.stderr).toBe(0)
    expect(result(draft.stdout)).toMatchObject({ asset: { id: f.input.assetId, revision: 1, sourceRecordingId: f.input.sourceRecordingId, draft: { steps: [{ reviewed: false }] } } })
    const before = await readFile(f.assetPath, 'utf8')
    const checked = await cli(f, ['create-inspect', ...flags, '--input', '-'], JSON.stringify(f.input)); expect(checked.code, checked.stderr).toBe(0)
    expect(result(checked.stdout)).toMatchObject({ creation: { status: 'created', assetId: f.input.assetId, createOperationId: f.input.createOperationId } })
    const next = await f.recorder.start({ browserId, navigationId: 'later-navigation', url })
    const current = await cli(f, ['source', ...flags]); expect(current.code, current.stderr).toBe(0)
    expect(result(current.stdout)).toMatchObject({ source: { id: next.id, revision: next.revision, status: 'recording' } })
    const running = await cli(f, ['create', ...flags, '--input', '-'], JSON.stringify(browserTaskCreateInput(next)))
    expect(running.code).toBe(1); expect(running.stderr).toContain('BROWSER_TASK_CREATE_SOURCE_CONFLICT')
    expect((await f.recorder.get(browserId))!.status).toBe('recording')
    const repeated = await cli(f, ['create', ...flags, '--input', '-'], JSON.stringify(f.input)); expect(repeated.code, repeated.stderr).toBe(0)
    expect(await readFile(f.assetPath, 'utf8')).toBe(before); expect((await f.assets.state()).assets).toHaveLength(1); expect((await f.assets.state()).runs).toEqual([])
    for (const action of [f.automation, f.createPage, f.restorePage, f.runPage]) expect(action).not.toHaveBeenCalled()
    const reopened = await processRun(process.execPath, [processBundle, 'inspect', f.assetPath, f.sourcePath, f.inputPath]); expect(reopened.code, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toMatchObject({ status: 'created', assetId: f.input.assetId }); expect(await readFile(f.assetPath, 'utf8')).toBe(before)
  } finally { await f.server.stop() }
}, 30_000)

it('rejects forged bodies, changed source/intent and invalid JSON without exposing original bytes', async () => {
  const f = await fixture()
  try {
    for (const input of [{ ...f.input, sourceRevision: 3 }, { ...f.input, sourceRecordingId: 'foreign' }, { ...f.input, browserId: 'foreign' }, { ...f.input, recording: { password: sentinel } }, { ...f.input, reviewed: true }]) {
      const bad = await cli(f, ['create', ...flags, '--input', '-'], JSON.stringify(input)); expect(bad.code).toBe(1); expect(bad.stderr).not.toContain(sentinel)
    }
    const malformed = await cli(f, ['create', ...flags, '--input', '-'], '{"' + sentinel + '":'); expect(malformed.code).toBe(1); expect(malformed.stderr).not.toContain(sentinel)
    expect((await f.assets.state()).assets).toEqual([])
    expect((await cli(f, ['create', ...flags, '--input', f.inputPath])).code).toBe(0); const before = await readFile(f.assetPath, 'utf8')
    const fresh = browserTaskCreateInput({ id: f.input.sourceRecordingId, browserId, revision: 2 })
    for (const change of [{ name: 'Another original name' }, { assetId: fresh.assetId }, { createOperationId: fresh.createOperationId }]) {
      const bad = await cli(f, ['create', ...flags, '--input', '-'], JSON.stringify({ ...f.input, ...change })); expect(bad.code).toBe(1); expect(bad.stderr).toContain('BROWSER_TASK_CREATE_CONFLICT')
      const check = await cli(f, ['create-inspect', ...flags, '--input', '-'], JSON.stringify({ ...f.input, ...change })); expect(check.code).toBe(1); expect(check.stderr).toContain('BROWSER_TASK_CREATE_CONFLICT')
    }
    expect(await readFile(f.assetPath, 'utf8')).toBe(before)
  } finally { await f.server.stop() }
}, 30_000)

it.each(['before', 'after', 'reply'] as const)('keeps %s uncertainty for only the original inspect/continue input', async fault => {
  const f = await fixture()
  try {
    if (fault === 'reply') f.loseReply(); else f.setFault(fault)
    expect((await cli(f, ['create', ...flags, '--input', f.inputPath])).code).toBe(1)
    const checked = await cli(f, ['create-inspect', ...flags, '--input', f.inputPath]); expect(checked.code, checked.stderr).toBe(0)
    expect(result(checked.stdout)).toMatchObject({ creation: { assetId: f.input.assetId, status: fault === 'before' ? 'unknown' : 'created' } })
    f.setFault(undefined); const continued = await cli(f, ['create', ...flags, '--input', f.inputPath]); expect(continued.code, continued.stderr).toBe(0)
    expect((await f.assets.state()).assets.map(asset => asset.id)).toEqual([f.input.assetId])
  } finally { await f.server.stop() }
})

it('bounded source/draft and compact creation preserve and bypass over one MiB of retained history', async () => {
  const f = await fixture()
  try {
    const oldInput = browserTaskCreateInput((await f.recorder.get(browserId))!, 'Original history'), old = await f.manager.importTaskAsset(browserId, oldInput)
    const document = await f.disk.load(), row = document!.assets[0]!
    row.versions = Array.from({ length: 8 }, (_, index) => ({ ...row.draft, version: index + 1, savedAt: index + 1,
      steps: Array.from({ length: 128 }, (_, step) => ({ id: 'step-' + step, kind: 'navigate' as const, url: url + '/' + 'p'.repeat(1800), reviewed: true })) }))
    await f.disk.save(document!); expect((await readFile(f.assetPath)).length).toBeGreaterThan(1_048_576)
    const assets = new BrowserTaskAssets(f.disk); Object.assign(f.manager, { taskAssets: assets }); const versions = (await assets.get(old.id))!.versions
    const source = await cli(f, ['source', ...flags]); expect(source.code, source.stderr).toBe(0)
    const draft = await cli(f, ['draft', ...flags, '--asset', old.id]); expect(draft.code, draft.stderr).toBe(0); expect(draft.stdout.length).toBeLessThan(10_000)
    const created = await cli(f, ['create', ...flags, '--input', f.inputPath]); expect(created.code, created.stderr).toBe(0); expect(created.stdout.length).toBeLessThan(2000)
    expect((await assets.get(old.id))!.versions).toEqual(versions); expect((await assets.state()).assets).toHaveLength(2)
    const disk = new BrowserTaskAssets(f.disk); expect((await disk.get(old.id))!.versions).toEqual(versions); expect((await disk.get(f.input.assetId))!.creation).toEqual(f.input)
  } finally { await f.server.stop() }
}, 30_000)

it('a confirmed creation receipt never claims that a later unsaved draft revision was saved', async () => {
  const f = await fixture()
  try {
    expect((await cli(f, ['create', ...flags, '--input', f.inputPath])).code).toBe(0)
    const saved = await readFile(f.assetPath, 'utf8'), asset = (await f.assets.get(f.input.assetId))!
    f.setFault('before')
    await expect(f.assets.edit(asset.id, asset.revision, { ...asset.draft, name: 'Retained unsaved edit' })).rejects.toMatchObject({ code: 'BROWSER_TASK_SAVE_UNCONFIRMED' })
    const again = await cli(f, ['create', ...flags, '--input', f.inputPath]); expect(again.code, again.stderr).toBe(0)
    expect(result(again.stdout)).toEqual({ creation: { assetId: asset.id, browserId, createOperationId: f.input.createOperationId, status: 'created' } })
    expect(again.stdout).not.toContain('revision')
    const draft = await cli(f, ['draft', ...flags, '--asset', asset.id]); expect(draft.code, draft.stderr).toBe(0)
    expect(result(draft.stdout)).toMatchObject({ asset: { revision: asset.revision + 1, draft: { name: 'Retained unsaved edit' }, warning: expect.stringContaining('could not be saved') } })
    expect(await readFile(f.assetPath, 'utf8')).toBe(saved)
  } finally { await f.server.stop() }
})

it('an unreadable original source remains unavailable without leaking its body or rewriting the file', async () => {
  const f = await fixture()
  try {
    const damaged = '{"' + sentinel + '":'
    await writeFile(f.sourcePath, damaged)
    Object.assign(f.manager, { demonstrations: new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(f.sourcePath)) })
    const source = await cli(f, ['source', ...flags]); expect(source.code).toBe(1); expect(source.stderr).not.toContain(sentinel)
    expect(source.stderr).toContain('could not be observed'); expect(await readFile(f.sourcePath, 'utf8')).toBe(damaged)
    expect((await f.assets.state()).assets).toEqual([])
    for (const action of [f.automation, f.createPage, f.restorePage, f.runPage]) expect(action).not.toHaveBeenCalled()
  } finally { await f.server.stop() }
})

it('strict discovery and result decoding keep source data and receipt targets exact', () => {
  for (const operation of ['source', 'draft', 'create', 'create-inspect']) { expect(agentMuxCommandHelp('browser.task.' + operation)).toContain('--browser'); expect(agentMuxModuleSkill('browser')).toContain('create-inspect') }
  const input = browserTaskCreateInput({ id: 'source', browserId, revision: 2 })
  for (const request of [{ operation: 'browser.task.source', browserId }, { operation: 'browser.task.draft', browserId, assetId: input.assetId }, { operation: 'browser.task.create', browserId, input }, { operation: 'browser.task.create-inspect', browserId, input }]) {
    const full = { schemaVersion: 5, requestId: 'original-request', ...request }; expect(() => parseAgentMuxControlRequest({ ...full, approved: true })).toThrow(); expect(parseAgentMuxControlRequest(full)).toMatchObject(request)
  }
  expect(() => parseBrowserTaskControlResult('browser.task.source', { browserId, source: { id: 'source', browserId, revision: 2, status: 'stopped', stepCount: 1, args: [sentinel] } })).toThrow()
  expect(() => assertBrowserTaskControlTarget({ operation: 'browser.task.create', browserId, input }, { operation: 'browser.task.create', creation: { assetId: 'wrong', browserId, status: 'created', createOperationId: input.createOperationId } })).toThrow()
})
