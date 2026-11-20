import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import type { BrowserTaskParallelInspection, BrowserTaskParallelInput } from '@agentmux/core/control'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets.js'
import { executeBrowserTaskControl } from '../../../src/main/browser-task-control.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
import { importTaskRecording } from '../../../test/helpers/import-task-recording.js'
import type { BrowserTaskContent, BrowserTaskStep } from '../../../src/shared/browser-task-assets.js'

const home = process.env.TASK_PARALLEL_HOME!, out = process.env.TASK_PARALLEL_OUT!, base = process.env.TASK_PARALLEL_BASE!
const phase = process.env.TASK_PARALLEL_PHASE!, node = process.env.TASK_PARALLEL_NODE!, source = 'parallel-source'
assert.ok(basename(home).startsWith('amux-task-parallel-'))
app.on('window-all-closed', () => {})
const receipt: any = { passed: false, phase, pid: process.pid, cases: [], cli: [], dialogs: [] }
const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(home, 'assets.json')))
let window: BrowserWindow | undefined, profiles: BrowserProfileManager | undefined, manager: BrowserViewManager | undefined, control: AgentMuxControlServer | undefined
const pause = (millis: number) => new Promise(done => setTimeout(done, millis))
const contents = (id: string) => manager!.nativeOwner(id)!.view.webContents
const facts = (id: string) => contents(id).executeJavaScript('parallelProof.facts()')
const target = (name: string, role = 'button') => ({ role, name, ordinal: 1, count: 1 })
const click = (id: string, name: string): BrowserTaskStep => ({ id, kind: 'click', url: base, target: target(name), reviewed: true })
const wait = (): BrowserTaskStep => ({ id: 'await-page', kind: 'wait', url: base,
  wait: { kind: 'element-present', target: { role: 'button', name: 'Gate opened' } }, timeoutMs: 25_000, reviewed: true })
async function until<T>(read: () => Promise<T | null | false | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 22_000
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(25) }
  throw new Error('Private native observation did not settle: ' + label)
}
async function cli(args: string[], input = '') {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(node, [join(out, 'cli.mjs'), '--endpoint', 'unix:' + join(home, 'control.sock'), 'browser', 'task', ...args], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE')),
      stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Private CLI observation did not complete: ' + args[0])) }, 90_000)
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', code => { clearTimeout(deadline); accept({ code, stdout, stderr }) }); child.stdin.end(input)
  })
  receipt.cli.push({ command: args[0], code: result.code })
  assert.equal(result.code, 0, result.stderr + result.stdout)
  return JSON.parse(result.stdout).result
}
async function publish(assetId: string, content: BrowserTaskContent) {
  const current = (await assets.get(assetId))!
  const edited = await cli(['edit', '--browser', source, '--asset', assetId, '--expected-revision', String(current.revision), '--input', '-'], JSON.stringify(content))
  return await cli(['publish', '--browser', source, '--asset', assetId, '--expected-revision', String(edited.asset.revision)])
}
async function make() {
  const created = await manager!.create(source, base)
  const imported = await importTaskRecording(assets, { id: 'private-parallel-definition', browserId: source, navigationId: created.navigationId,
    url: base, status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] }, 'Original shared definition')
  await publish(imported.id, { name: 'Original shared definition', url: base,
    parameters: [{ key: 'value', label: 'Item value', secret: true }], steps: [
      { id: 'fill', kind: 'fill', url: base, target: target('Item value', 'text input'), parameterKey: 'value', reviewed: true },
      click('submit', 'Submit item'), wait(), { ...click('confirm', 'Confirm item'), dialog: { type: 'confirm', action: 'accept' } }
    ] })
  return (await assets.get(imported.id))!
}
const start = (assetId: string, input: BrowserTaskParallelInput) => cli(['parallel', '--browser', source, '--asset', assetId, '--version', '1', '--input', '-'], JSON.stringify(input))
async function inspect(operationId: string): Promise<BrowserTaskParallelInspection> {
  const first = (await cli(['parallel-inspect', '--browser', source, '--operation-id', operationId, '--limit', '2'])).inspection as BrowserTaskParallelInspection
  assert.ok(first); assert.equal(first.run.operationId, operationId); assert.equal(first.page.after, null)
  const all = [...first.targets]; let after = first.page.nextAfter
  while (after) {
    const next = (await cli(['parallel-inspect', '--browser', source, '--operation-id', operationId, '--after', after, '--limit', '2'])).inspection as BrowserTaskParallelInspection
    assert.ok(next); assert.equal(next.page.after, after); assert.equal(next.run.operationId, operationId)
    all.push(...next.targets); after = next.page.nextAfter
  }
  assert.equal(all.length, first.run.targetCount); assert.equal(new Set(all.map(target => target.id)).size, all.length)
  return { ...first, targets: all }
}
async function privateInspect(operationId: string) { return (await manager!.inspectTaskParallel(source, operationId, undefined, 64))! }
async function pageFacts(targets: { browserId: string }[]) { return Object.fromEntries(await Promise.all(targets.map(async ({ browserId }) => [browserId, await facts(browserId)]))) }
async function ownerValuesAbsent(values: string[]) {
  receipt.ownerFileValueChecks ??= []
  for (const name of ['assets.json', 'refs.json', 'journal.sqlite', 'journal.sqlite-wal']) {
    let bytes: Buffer
    try { bytes = await readFile(join(home, name)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !['refs.json', 'journal.sqlite-wal'].includes(name)) throw error
      receipt.ownerFileValueChecks.push({ file: name, present: false }); continue
    }
    for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, 'Fresh invocation values remain outside original owner file ' + name)
    receipt.ownerFileValueChecks.push({ file: name, present: true, freshValuesAbsent: true })
  }
}
async function first(targets: { browserId: string; profileId: string }[]) {
  const asset = await make(), input: BrowserTaskParallelInput = { operationId: 'original-parallel-operation', concurrency: 3,
    targets: targets.map((item, index) => ({ id: ['shared-first', 'shared-second', 'independent', 'failed-page'][index]!, ...item,
      parameters: { value: 'fresh parallel value ' + index + ' private' } })) }
  const before = await pageFacts(targets), admission = (await start(asset.id, input)).run
  assert.equal(admission.operationId, input.operationId); assert.equal(admission.targetCount, 4); assert.equal(admission.version, 1)
  assert.ok(admission.concurrency >= 2, 'Native resource capacity admits at least two distinct Profiles')
  const overlap = await until(async () => {
    const row = await privateInspect(input.operationId), [first, second, other, failed] = row.targets
    return first?.run?.status === 'running' && first.run.nextStep === 2 && second?.phase === 'queued' &&
      other?.run?.status === 'running' && other.run.nextStep === 2 && failed?.run?.status === 'failed' ? row : null
  }, 'two different native Profile waits overlap after the independent target failure')
  await contents(targets[2]!.browserId).executeJavaScript('parallelProof.openGate()')
  const concurrent = await until(async () => {
    const row = await privateInspect(input.operationId), [first, second, other, failed] = row.targets
    return first?.run?.status === 'running' && first.run.nextStep === 2 && second?.phase === 'queued' && second.waitingForProfile?.targetId === first.id &&
      other?.run?.status === 'completed' && failed?.run?.status === 'failed' ? row : null
  }, 'same-Profile queue while another actual Profile completes and a real page target fails')
  assert.equal((await facts(targets[1]!.browserId)).state.items.length, before[targets[1]!.browserId].state.items.length)
  assert.equal((await facts(targets[2]!.browserId)).state.confirmed - before[targets[2]!.browserId].state.confirmed, 1)
  receipt.cases.push({ kind: 'native-profile-concurrency-queue-and-failure-isolation', admission, overlap, concurrent, pages: await pageFacts(targets) })
  // The queued target has not started. A later published version must not replace its frozen v1.
  await publish(asset.id, { ...asset.draft, steps: [click('changed', 'Changed version')] })
  await contents(source).executeJavaScript('parallelProof.openGate()')
  await until(async () => { const row = await privateInspect(input.operationId); return row.run.status !== 'running' ? row : null }, 'remaining original targets finish')
  const completed = await inspect(input.operationId), after = await pageFacts(targets)
  assert.equal(completed.run.status, 'failed'); assert.equal(completed.run.counts.completed, 3); assert.equal(completed.run.counts.failed, 1)
  assert.deepEqual(completed.targets.map(target => target.id), input.targets.map(target => target.id))
  for (let index = 0; index < targets.length; index++) {
    const item = targets[index]!, original = completed.targets[index]!
    assert.equal(original.browserId, item.browserId); assert.equal(original.profileId, item.profileId); assert.ok(original.run)
    const exact = (await cli(['inspect', '--browser', item.browserId, '--run', original.run.id])).inspection
    assert.ok(exact.runs.every((run: any) => run.assetId === asset.id && run.version === 1 && run.browserId === item.browserId))
    assert.equal((await assets.state(item.browserId)).assets.length, index === 0 ? 1 : 0, 'Targets reuse source asset; their libraries get no copy')
    assert.equal(after[item.browserId].draft, before[item.browserId].draft); assert.equal(after[item.browserId].state.changed, 0)
    if (index < 3) {
      assert.deepEqual(after[item.browserId].state.items, [...before[item.browserId].state.items, input.targets[index]!.parameters.value])
      assert.equal(after[item.browserId].state.confirmed - before[item.browserId].state.confirmed, 1)
      assert.ok(receipt.dialogs.some((dialog: any) => dialog.browserId === item.browserId && dialog.method === 'Page.javascriptDialogOpening' && dialog.type === 'confirm'))
    } else assert.deepEqual(after[item.browserId].state, before[item.browserId].state)
  }
  await ownerValuesAbsent(input.targets.map(target => target.parameters.value!))
  receipt.cases.push({ kind: 'compiled-public-cli-fixed-source-v1-exact-paged-results', completed, before, after })

  // Keep actual native wait operations in flight across process exit. The shared-Profile
  // second target stays queued; no new definition, run or fresh input is seeded on restart.
  for (const id of [source, targets[2]!.browserId]) await contents(id).executeJavaScript('parallelProof.closeGate()')
  const inflight: BrowserTaskParallelInput = { operationId: 'original-inflight-parallel', concurrency: 3,
    targets: input.targets.slice(0, 3).map((item, index) => ({ ...item, parameters: { value: 'inflight private fresh value ' + index } })) }
  await start(asset.id, inflight)
  const running = await until(async () => {
    const row = await privateInspect(inflight.operationId)
    if (row.targets[0]?.run?.nextStep !== 2 || row.targets[0]?.run?.status !== 'running' || row.targets[2]?.run?.nextStep !== 2 || row.targets[2]?.run?.status !== 'running' || row.targets[1]?.phase !== 'queued') return null
    for (const target of [row.targets[0], row.targets[2]]) {
      const exact = await assets.inspect(target.browserId, target.run!.id), original = exact!.runs[0]!
      if (original.operationIds.length !== 3 || !(await manager!.getOperation(original.operationIds[2]!))?.steps.some(step => step.method === 'snapshot' && step.status === 'completed')) return null
    }
    return row
  }, 'two real wait operations dispatched before first process exits')
  const originalRuns = await Promise.all(running.targets.filter(target => target.run).map(async target => (await assets.inspect(target.browserId, target.run!.id))!.runs[0]))
  await ownerValuesAbsent(inflight.targets.map(target => target.parameters.value!))
  const pages = await pageFacts(targets)
  receipt.retained = { targets, assetId: asset.id, completed, running, originalRuns, pages }
  await writeFile(join(home, 'retained.json'), JSON.stringify(receipt.retained))
  receipt.cases.push({ kind: 'native-original-two-profile-waits-and-queued-target-at-exit', running, originalRuns, pages })
}
async function second(prior: any) {
  const completed = await inspect(prior.completed.run.operationId), running = await inspect(prior.running.run.operationId), pages = await pageFacts(prior.targets)
  assert.deepEqual(completed, prior.completed); assert.deepEqual(pages, prior.pages)
  assert.equal(running.run.status, 'interrupted'); assert.equal(running.run.operationId, prior.running.run.operationId)
  assert.deepEqual(running.targets.map(target => ({ id: target.id, browserId: target.browserId, profileId: target.profileId, phase: target.phase, runId: target.run?.id })),
    prior.running.targets.map((target: any) => ({ id: target.id, browserId: target.browserId, profileId: target.profileId, phase: target.phase, runId: target.run?.id })))
  assert.equal(running.targets[1]!.run, undefined); assert.equal(running.targets[1]!.phase, 'queued')
  const originals = await Promise.all(running.targets.filter(target => target.run).map(async target => (await cli(['inspect', '--browser', target.browserId, '--run', target.run!.id])).inspection.runs[0]))
  const cursors = (runs: any[]) => runs.map(run => ({ id: run.id, browserId: run.browserId, assetId: run.assetId, version: run.version, nextStep: run.nextStep, operationIds: run.operationIds, orchestration: run.orchestration }))
  assert.deepEqual(cursors(originals), cursors(prior.originalRuns)); assert.ok(originals.every(run => run.status === 'interrupted'))
  receipt.cases.push({ kind: 'second-process-original-targets-runs-cursors-and-partitions', completed, running, originals, pages })
  const repeat: BrowserTaskParallelInput = { operationId: running.run.operationId, concurrency: 3,
    targets: running.targets.map(target => ({ id: target.id, browserId: target.browserId, profileId: target.profileId, parameters: { value: 'must never be replayed after restart' } })) }
  const observed = (await start(prior.assetId, repeat)).run
  assert.equal(observed.operationId, running.run.operationId); assert.equal(observed.status, 'interrupted')
  await pause(150)
  assert.deepEqual(await pageFacts(prior.targets), pages); assert.deepEqual(await inspect(running.run.operationId), running)
  assert.deepEqual(receipt.dialogs, [])
  receipt.original = prior
  receipt.cases.push({ kind: 'same-original-operation-is-read-after-restart-without-replay', observed })
}
async function main() {
  try {
    await app.whenReady(); app.setActivationPolicy?.('prohibited')
    window = new BrowserWindow({ width: 800, height: 700, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
    await window.loadURL('data:text/html,Private parallel task host')
    profiles = new BrowserProfileManager(new BrowserProfileStore(join(home, 'profiles.json'))); await profiles.initialize()
    manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(home, 'refs.json')),
      { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} },
      new BrowserOperationJournal(new BrowserOperationFileStore(join(home, 'journal.sqlite'))), undefined, undefined, undefined, assets)
    const prior = phase === 'second' ? JSON.parse(await readFile(join(home, 'retained.json'), 'utf8')) : null
    const shared = prior ? null : await profiles.createProfile('Shared exact Profile'), independent = prior ? null : await profiles.createProfile('Independent exact Profile'), failed = prior ? null : await profiles.createProfile('Failed page Profile')
    const targets = prior?.targets ?? [{ browserId: source, profileId: shared!.id }, { browserId: 'parallel-shared-second', profileId: shared!.id },
      { browserId: 'parallel-independent', profileId: independent!.id }, { browserId: 'parallel-failed-page', profileId: failed!.id }]
    assert.equal(new Set(targets.map((target: any) => target.profileId)).size, 3)
    for (const [index, target] of targets.entries()) {
      const created = await manager.create(target.browserId, base, undefined, target.profileId, undefined, 'responsive', { agent: { hostId: 'private-fixture', agentSessionId: 'private-unobserved-association' } })
      assert.equal(created.profileId, target.profileId); manager.setBounds(target.browserId, { x: 0, y: 0, width: 760, height: 640 }); contents(target.browserId).setBackgroundThrottling(false)
      contents(target.browserId).debugger.on('message', (_event, method, params: any) => {
        if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed') receipt.dialogs.push({ browserId: target.browserId, method, type: params?.type, result: params?.result })
      })
      await until(async () => await contents(target.browserId).executeJavaScript('typeof parallelProof === "object"').catch(() => false), 'actual fixture document')
      await contents(target.browserId).executeJavaScript(`parallelProof.configure(${JSON.stringify(target.browserId)},${JSON.stringify({ closed: index === 0 || index === 2, bad: index === 3 })})`)
      if (!prior) await manager.returnControl(target.browserId)
    }
    control = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: request => executeBrowserTaskControl(request, manager!, true) }); await control.start()
    if (phase === 'first') await first(targets); else await second(prior)
    for (const target of targets) contents(target.browserId).session.flushStorageData()
    receipt.passed = true
  } catch (error) { receipt.failure = { message: (error as Error).message, stack: (error as Error).stack }; console.error(error) }
  finally {
    if (phase === 'first' && receipt.passed) {
      receipt.termination = 'Original process exits with two real wait operations in flight and one original same-Profile target queued.'
      await writeFile(join(out, phase + '.json'), JSON.stringify(receipt, null, 2) + '\n'); app.exit(0); return
    }
    await control?.stop(); manager?.dispose(); await profiles?.dispose(); window?.destroy()
    await writeFile(join(out, phase + '.json'), JSON.stringify(receipt, null, 2) + '\n'); app.exit(receipt.passed ? 0 : 1)
  }
}
void main()
