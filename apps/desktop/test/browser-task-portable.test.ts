// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { AgentMuxControlServer, parseAgentMuxControlRequest } from '../../../packages/core/src/control-host.js'
import { browserTaskImportInput, parseBrowserTaskControlResult, assertBrowserTaskControlTarget, type BrowserTaskPortableBundle } from '../../../packages/core/src/browser-task-control.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'
import { importTaskRecording } from './helpers/import-task-recording.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import { executeBrowserTaskControl } from '../src/main/browser-task-control.js'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'

const url = 'https://portable.invalid/form', sourceBrowser = 'source-browser', targetBrowser = 'target-browser', secret = 'fresh-runtime-private-sentinel'
const roots: string[] = []
let processBundle: string
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-portable-code-')); roots.push(root)
  await build({ configFile: false, logLevel: 'silent', build: { ssr: true, minify: false, emptyOutDir: false, outDir: root,
    rollupOptions: { input: resolve('apps/desktop/test/fixtures/browser-task-portable-process.ts'), external: id => !id.startsWith('.') && !id.startsWith('/'), output: { format: 'es', entryFileNames: 'process.mjs' } } } })
  await symlink(resolve('apps/desktop/node_modules'), join(root, 'node_modules')); processBundle = join(root, 'process.mjs')
})
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })
afterEach(() => vi.restoreAllMocks())
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-portable-')); roots.push(root)
  const path = join(root, 'assets.json'), disk = new BrowserTaskAssetFileStore(path)
  let fault: 'before' | 'after' | undefined, loseReply = false
  const store: BrowserTaskAssetStore = { load: () => disk.load(), save: async value => {
    if (fault === 'before') throw Error(secret)
    await disk.save(value)
    if (fault === 'after') throw Error(secret)
  } }
  const assets = new BrowserTaskAssets(store), manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(manager, { taskAssets: assets, entries: new Map(), taskExecutions: new Map() })
  vi.spyOn(manager as any, 'emit').mockImplementation(() => {})
  const create = vi.spyOn(manager, 'create'), restore = vi.spyOn(manager, 'restore'), page = vi.spyOn(manager, 'runScript')
  const automation = vi.fn(async (): Promise<void> => { throw Error('Page execution is disabled') })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => {
    const result = await executeBrowserTaskControl(request, manager, automation)
    if (request.operation === 'browser.task.import' && loseReply) { loseReply = false; throw Error('Private reply lost') }
    return result
  } }); await server.start()
  return { root, path, disk, assets, manager, server, create, restore, page, automation,
    setFault: (value: typeof fault) => { fault = value }, loseReply: () => { loseReply = true } }
}
async function processRun(args: string[], input = '', env?: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string; pid: number }>((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: resolve('.'), env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('Private portable caller did not finish')) }, 20_000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => {}); child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); accept({ code: code ?? -1, stdout, stderr, pid: child.pid! }) }); child.stdin.end(input)
  })
}
const cli = (f: Awaited<ReturnType<typeof fixture>>, args: string[], input = '') => processRun([resolve('packages/core/dist/agentmux.js'), 'browser', 'task', ...args], input, objectCliEnvironment(f.root))
const result = (stdout: string) => objectCliReceipt(JSON.parse(stdout)).result as any
const exportArgs = (id: string, revision: number, version?: number) => ['export', '--browser', sourceBrowser, '--asset', id, '--expected-revision', String(revision), ...(version === undefined ? [] : ['--version', String(version)])]
const importArgs = (action = 'import') => [action, '--browser', targetBrowser, '--input', '-']
async function source(f: Awaited<ReturnType<typeof fixture>>) {
  const original = await importTaskRecording(f.assets, { id: 'actual-local-recording', browserId: sourceBrowser, navigationId: 'actual-local-navigation', revision: 1,
    status: 'stopped', startedAt: 1, updatedAt: 2, url, steps: [] })
  const edited = await f.assets.edit(original.id, original.revision, { name: 'Portable graph', url,
    parameters: [{ key: 'account', label: 'Account', secret: true }], steps: [
      { id: 'branch', kind: 'branch', url, reviewed: true, branch: { condition: { kind: 'page-url-is', url }, onTrue: 'fill', onFalse: 'click' } },
      { id: 'fill', kind: 'fill', url, reviewed: true, parameterKey: 'account', target: { role: 'textbox', name: 'Account', ordinal: 1, count: 1 }, nextStepId: 'click', onFail: { goto: 'approval' }, retry: 1 },
      { id: 'click', kind: 'click', url, reviewed: true, target: { role: 'button', name: 'Download', ordinal: 1, count: 1 } },
      { id: 'approval', kind: 'checkpoint', url, reviewed: true }
    ], completion: { criteria: [{ kind: 'download-readable', stepId: 'click', path: 'outputs/report.csv' }, { kind: 'human-checkpoint', checkpointId: 'approval' }] } })
  return f.assets.saveVersion(edited.id, edited.revision)
}
async function bundle(f: Awaited<ReturnType<typeof fixture>>) {
  const asset = await source(f), reply = await cli(f, exportArgs(asset.id, asset.revision, 1))
  expect(reply.code, reply.stderr).toBe(0)
  return { asset, bundle: result(reply.stdout).bundle as BrowserTaskPortableBundle }
}

it('compiled CLI → RPC → Main → original owners exports one complete version and imports a new inspectable graph in a clean directory', async () => {
  const from = await fixture(), to = await fixture()
  try {
    const { asset, bundle: exported } = await bundle(from), bytes = await readFile(from.path, 'utf8')
    expect(exported.source).toEqual({ assetId: asset.id, revision: asset.revision, publishedVersion: 1 })
    expect(exported.definition.parameters).toEqual(asset.draft.parameters)
    expect((exported.definition.steps as any[]).every(step => step.reviewed === false)).toBe(true)
    for (const forbidden of ['actual-local-recording', 'actual-local-navigation', sourceBrowser, 'createOperationId', 'runs', 'humanCheckpoints', secret, 'args']) expect(JSON.stringify(exported)).not.toContain(forbidden)
    expect(await to.disk.load()).toBeNull()
    const input = browserTaskImportInput(targetBrowser, exported), imported = await cli(to, importArgs(), JSON.stringify(input))
    expect(imported.code, imported.stderr).toBe(0)
    expect(result(imported.stdout)).toEqual({ creation: { createOperationId: input.createOperationId, assetId: input.assetId, browserId: targetBrowser, status: 'created' } })
    const saved = await to.assets.get(input.assetId), steps = saved!.draft.steps, [branch, fill, click, checkpoint] = steps
    expect(saved).toMatchObject({ browserId: targetBrowser, importedFrom: exported.source, revision: 1, versions: [] })
    expect(saved!.sourceRecordingId).toBeUndefined()
    expect(steps).toHaveLength(4); expect(new Set(steps.map(step => step.id)).size).toBe(4)
    expect(steps.every(step => !['branch', 'fill', 'click', 'approval'].includes(step.id) && step.reviewed === false)).toBe(true)
    expect(branch!.branch).toMatchObject({ onTrue: fill!.id, onFalse: click!.id })
    expect(fill).toMatchObject({ parameterKey: 'account', nextStepId: click!.id, onFail: { goto: checkpoint!.id }, retry: 1 })
    expect(saved!.draft.completion).toEqual({ criteria: [{ kind: 'download-readable', stepId: click!.id, path: 'outputs/report.csv' }, { kind: 'human-checkpoint', checkpointId: checkpoint!.id }] })
    expect((await to.assets.state()).runs).toEqual([])
    const draft = await cli(to, ['draft', '--browser', targetBrowser, '--asset', input.assetId]); expect(draft.code, draft.stderr).toBe(0)
    expect(result(draft.stdout).asset).toMatchObject({ importedFrom: exported.source, draft: { parameters: asset.draft.parameters } })
    expect(await readFile(from.path, 'utf8')).toBe(bytes)
    for (const f of [from, to]) { expect(f.create).not.toHaveBeenCalled(); expect(f.restore).not.toHaveBeenCalled(); expect(f.page).not.toHaveBeenCalled(); expect(f.automation).not.toHaveBeenCalled() }
    const inputPath = join(to.root, 'retained-import.json'); await writeFile(inputPath, JSON.stringify(input))
    const restart = await processRun([processBundle, 'inspect', to.path, inputPath]); expect(restart.code, restart.stderr).toBe(0); expect(restart.pid).not.toBe(process.pid)
    expect(JSON.parse(restart.stdout)).toMatchObject({ assetId: input.assetId, status: 'created' })
    const repeated = await processRun([processBundle, 'import', to.path, inputPath]); expect(repeated.code, repeated.stderr).toBe(0)
    expect(JSON.parse(repeated.stdout)).toMatchObject({ id: input.assetId, count: 1, draft: saved!.draft })
  } finally { await from.server.stop(); await to.server.stop() }
}, 50_000)

it('imports need explicit review and fresh parameters; the same Main execution owner cannot inherit checkpoint approval', async () => {
  const f = await fixture()
  try {
    const portable: BrowserTaskPortableBundle = { format: 'agentmux.browser-task', version: 1, source: { assetId: 'origin-asset', revision: 3 }, definition: { name: 'Fresh local execution', url,
      parameters: [{ key: 'account', label: 'Account', secret: true }], steps: [
        { id: 'fill', kind: 'fill', url, parameterKey: 'account', target: { role: 'textbox', name: 'Account', ordinal: 1, count: 1 }, reviewed: false },
        { id: 'checkpoint', kind: 'checkpoint', url, reviewed: false }
      ] } }
    const input = browserTaskImportInput(targetBrowser, portable)
    expect((await cli(f, importArgs(), JSON.stringify(input))).code).toBe(0)
    let asset = (await f.assets.get(input.assetId))!
    const publishArgs = (revision: number) => ['publish', '--browser', targetBrowser, '--asset', asset.id, '--expected-revision', String(revision)]
    const firstPublished = await cli(f, publishArgs(asset.revision)); expect(firstPublished.code, firstPublished.stderr).toBe(0)
    asset = (await f.assets.get(asset.id))!
    const entry = { id: targetBrowser, humanControl: false, activity: { control: 'agent' }, navigationId: 'fresh-navigation', view: { webContents: { isDestroyed: () => false } } }
    Object.assign(f.manager, { entries: new Map([[targetBrowser, entry]]) })
    f.automation.mockResolvedValue(undefined)
    const runArgs = (version: number) => ['run', '--browser', targetBrowser, '--asset', asset.id, '--version', String(version)]
    const unreviewed = await cli(f, runArgs(1), JSON.stringify({ account: secret })); expect(unreviewed.code).not.toBe(0); expect(unreviewed.stderr).toContain('Review')
    expect(f.page).not.toHaveBeenCalled()
    const edited = await cli(f, ['edit', '--browser', targetBrowser, '--asset', asset.id, '--expected-revision', String(asset.revision), '--input', '-'],
      JSON.stringify({ ...asset.draft, steps: asset.draft.steps.map(step => ({ ...step, reviewed: true })) }))
    expect(edited.code, edited.stderr).toBe(0)
    const published = await cli(f, publishArgs(result(edited.stdout).asset.revision)); expect(published.code, published.stderr).toBe(0)
    const fills: unknown[][] = []
    f.page.mockImplementation(async (id, code) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const result = await new AsyncFunction('pageInfo', 'snapshot', 'fillInput', code)(
        async () => ({ url }), async () => ({ observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }, missingFrames: [], nodes: [{ ref: '@e1', role: 'textbox', name: 'Account' }] }),
        async (...args: unknown[]) => { fills.push(args) })
      return { result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: 'actual-target-operation', browserId: id, phase: 'completed', operator: { id: 'caller', name: 'Caller' }, startedAt: 1, summary: 'Compiled portable task', url, steps: [] } }
    })
    vi.spyOn(f.manager as any, 'yieldControl').mockImplementation(() => { entry.humanControl = true; entry.activity.control = 'human' })
    const executed = await cli(f, runArgs(2), JSON.stringify({ account: secret })); expect(executed.code, executed.stderr).toBe(0)
    const run = (await f.assets.state(targetBrowser)).runs.find(item => item.id === result(executed.stdout).run.id)!
    expect(f.page).toHaveBeenCalledTimes(1); expect(f.page.mock.calls[0]![1]).toContain(secret); expect(fills).toEqual([['@e1', secret]])
    expect(run.status).toBe('waiting-human'); expect(run.pendingCheckpointId).toBe(asset.draft.steps[1]!.id); expect(run.humanCheckpoints).toEqual([])
    expect(await readFile(f.path, 'utf8')).not.toContain(secret)
    const continueReply = await cli(f, [...runArgs(2), '--run', run.id], JSON.stringify({ account: secret })); expect(continueReply.code).not.toBe(0); expect(continueReply.stderr).toContain('person')
  } finally { await f.server.stop() }
})

it.each(['before', 'after', 'reply'] as const)('keeps exact import identity after %s save/reply uncertainty and checks the durable file after reconstruction', async fault => {
  const from = await fixture(), to = await fixture()
  try {
    const { bundle: exported } = await bundle(from), input = browserTaskImportInput(targetBrowser, exported)
    if (fault === 'reply') to.loseReply(); else to.setFault(fault)
    const failed = await cli(to, importArgs(), JSON.stringify(input)); expect(failed.code).not.toBe(0); expect(failed.stderr).not.toContain(secret)
    const live = (await to.assets.state()).assets; expect(live).toHaveLength(1); expect(live[0]!.id).toBe(input.assetId)
    const status = await cli(to, importArgs('import-inspect'), JSON.stringify(input)); expect(status.code, status.stderr).toBe(0)
    expect(result(status.stdout).creation.status).toBe(fault === 'before' ? 'unknown' : 'created')
    const inputPath = join(to.root, 'intent.json'); await writeFile(inputPath, JSON.stringify(input))
    const restart = await processRun([processBundle, 'inspect', to.path, inputPath]); expect(restart.code, restart.stderr).toBe(0)
    expect(JSON.parse(restart.stdout).status).toBe(fault === 'before' ? 'not-found' : 'created')
    to.setFault(undefined)
    const resumed = await cli(to, importArgs(), JSON.stringify(input)); expect(resumed.code, resumed.stderr).toBe(0)
    const repeated = new BrowserTaskAssets(new BrowserTaskAssetFileStore(to.path)); expect((await repeated.state()).assets).toHaveLength(1)
    expect(await repeated.inspectPortableImport(input)).toMatchObject({ status: 'created', assetId: input.assetId })
    expect((await repeated.get(input.assetId))!.draft).toEqual(live[0]!.draft)
  } finally { await from.server.stop(); await to.server.stop() }
}, 50_000)

it('rejects conflicting operation, proposed asset, source or definition without claiming old recording assets or overwriting original bytes', async () => {
  const f = await fixture()
  try {
    const { asset, bundle: exported } = await bundle(f), input = browserTaskImportInput(targetBrowser, exported)
    expect((await cli(f, importArgs(), JSON.stringify(input))).code).toBe(0)
    const bytes = await readFile(f.path, 'utf8')
    for (const changed of [
      { ...input, assetId: 'another-asset' }, { ...input, createOperationId: 'another-operation' },
      { ...input, assetId: asset.id, createOperationId: 'claim-recording' },
      { ...input, bundle: { ...exported, source: { ...exported.source, revision: exported.source.revision + 1 } } },
      { ...input, bundle: { ...exported, definition: { ...exported.definition, name: 'Changed immutable intent' } } }
    ]) {
      const reply = await cli(f, importArgs(), JSON.stringify(changed)); expect(reply.code).not.toBe(0); expect(reply.stderr).toContain('BROWSER_TASK_CREATE_CONFLICT')
      expect(await readFile(f.path, 'utf8')).toBe(bytes)
    }
    const changedBrowser = await cli(f, importArgs(), JSON.stringify({ ...input, browserId: 'wrong-browser' })); expect(changedBrowser.code).not.toBe(0)
    expect(await readFile(f.path, 'utf8')).toBe(bytes)
    const imported = (await f.assets.get(input.assetId))!
    await f.assets.edit(imported.id, imported.revision, { ...imported.draft, name: 'Later local draft' })
    const checked = await cli(f, importArgs('import-inspect'), JSON.stringify(input)); expect(checked.code, checked.stderr).toBe(0)
    expect(result(checked.stdout).creation).toEqual({ createOperationId: input.createOperationId, assetId: input.assetId, browserId: targetBrowser, status: 'created' })
    // Existing pre-binding recording assets remain legitimate data, and cannot be claimed by a portable operation.
    const legacy = (await f.disk.load())!; delete legacy.assets.find(item => item.id === asset.id)!.creation; await f.disk.save(legacy)
    Object.assign(f.manager, { taskAssets: new BrowserTaskAssets(f.disk) })
    const legacyBytes = await readFile(f.path, 'utf8')
    const refused = await cli(f, importArgs(), JSON.stringify({ ...input, assetId: asset.id, createOperationId: 'claim-legacy-asset' }))
    expect(refused.code).not.toBe(0); expect(refused.stderr).toContain('BROWSER_TASK_CREATE_CONFLICT'); expect(await readFile(f.path, 'utf8')).toBe(legacyBytes)
  } finally { await f.server.stop() }
}, 50_000)

it('refuses unsupported fields, broken graphs, copied review/approval, private values and escaping paths before any asset write', async () => {
  const f = await fixture()
  try {
    const { bundle: exported } = await bundle(f), bytes = await readFile(f.path, 'utf8')
    const steps = exported.definition.steps as any[], parameters = exported.definition.parameters as any[]
    const invalid = [
      { ...exported, runs: [{ id: secret }] },
      { ...exported, definition: { ...exported.definition, parameters: [{ ...parameters[0], value: secret }] } },
      { ...exported, definition: { ...exported.definition, steps: [{ ...steps[0], reviewed: true }, ...steps.slice(1)] } },
      { ...exported, definition: { ...exported.definition, steps: [{ ...steps[0], branch: { ...steps[0].branch, onTrue: 'foreign-step' } }, ...steps.slice(1)] } },
      { ...exported, definition: { ...exported.definition, steps: [{ ...steps[0], rawArgs: [secret] }, ...steps.slice(1)] } },
      { ...exported, definition: { ...exported.definition, completion: { criteria: [{ kind: 'download-readable', stepId: 'click', path: '../escape.csv' }] } } }
    ]
    for (const rejected of invalid) {
      const input = { ...browserTaskImportInput(targetBrowser, exported), bundle: rejected }
      const reply = await cli(f, importArgs(), JSON.stringify(input)); expect(reply.code).not.toBe(0); expect(reply.stderr).not.toContain(secret)
      expect(await readFile(f.path, 'utf8')).toBe(bytes)
    }
    const badJson = await cli(f, importArgs(), `{"bundle":"${secret}`); expect(badJson.code).not.toBe(0); expect(badJson.stderr).not.toContain(secret)
    expect((await f.assets.state()).assets).toHaveLength(1)
  } finally { await f.server.stop() }
}, 50_000)

it('exports selected definitions beyond cumulative history budgets without mutating original versions, and exposes accurate strict public discovery/receipts', async () => {
  const f = await fixture()
  try {
    let asset = await source(f)
    const disk = (await f.disk.load())!
    const version = disk.assets[0]!.versions[0]!
    disk.assets[0]!.versions = Array.from({ length: 1600 }, (_, index) => ({ ...structuredClone(version), version: index + 1 }))
    await f.disk.save(disk); expect(Buffer.byteLength(JSON.stringify(disk))).toBeGreaterThan(1_048_576)
    Object.assign(f.manager, { taskAssets: new BrowserTaskAssets(f.disk) })
    const bytes = await readFile(f.path, 'utf8'), reply = await cli(f, exportArgs(asset.id, asset.revision, 1600)); expect(reply.code, reply.stderr).toBe(0)
    const exported = result(reply.stdout).bundle; expect(exported.source.publishedVersion).toBe(1600); expect(exported.definition.steps).toHaveLength(4)
    expect(Buffer.byteLength(reply.stdout)).toBeLessThan(16_384); expect(await readFile(f.path, 'utf8')).toBe(bytes)
    expect((await cli(f, exportArgs(asset.id, asset.revision + 1))).code).not.toBe(0)
    for (const action of ['export', 'import', 'import-inspect']) { const help = await cli(f, [action, '--help']); expect(help.code).toBe(0); expect(help.stdout).toContain(`browser task ${action}`) }
    const skill = await processRun([resolve('packages/core/dist/agentmux.js'), 'browser', '--skill']); expect(skill.code).toBe(0); expect(skill.stdout).toContain('portable')
    const input = browserTaskImportInput(targetBrowser, exported)
    expect(() => parseAgentMuxControlRequest({ operation: 'browser.task.import', browserId: targetBrowser, input, approve: true })).toThrow()
    expect(() => assertBrowserTaskControlTarget({ operation: 'browser.task.export', browserId: sourceBrowser, assetId: asset.id, expectedRevision: asset.revision, version: 1 }, { operation: 'browser.task.export', bundle: exported })).toThrow()
    expect(() => parseBrowserTaskControlResult('browser.task.import', { creation: { createOperationId: input.createOperationId, assetId: input.assetId, browserId: targetBrowser, status: 'unknown' } })).toThrow()
  } finally { await f.server.stop() }
}, 50_000)


it('exports wait for the original pending write and cannot claim an unsaved live revision as portable provenance', async () => {
  const f = await fixture()
  try {
    const asset = await source(f), bytes = await readFile(f.path, 'utf8')
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const save = vi.spyOn(f.disk, 'save').mockImplementation(async () => { await blocked; throw Error(secret) })
    const editing = f.assets.edit(asset.id, asset.revision, { ...asset.draft, name: 'Unconfirmed new definition' })
    const failed = expect(editing).rejects.toMatchObject({ code: 'BROWSER_TASK_SAVE_UNCONFIRMED' })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    let exportFinished = false
    const exporting = f.assets.exportPortable(asset.id, asset.revision + 1).finally(() => { exportFinished = true })
    const refused = expect(exporting).rejects.toMatchObject({ code: 'BROWSER_TASK_EXPORT_UNAVAILABLE' })
    await new Promise(resolve => setImmediate(resolve)); expect(exportFinished).toBe(false)
    release(); await failed; await refused
    expect(await readFile(f.path, 'utf8')).toBe(bytes)
    expect((await f.assets.get(asset.id))!.draft.name).toBe('Unconfirmed new definition')
    expect(f.create).not.toHaveBeenCalled(); expect(f.page).not.toHaveBeenCalled()
  } finally { await f.server.stop() }
})
