import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PerformanceToolkitOwner, ToolkitOwner } from '../../../src/main/toolkit-owner.js'
import { ToolkitReceiptStore } from '../../../src/main/toolkit-receipt-store.js'
import { ConfigOwner } from '../../../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../../../src/main/config-store.js'
import type { ToolkitRunPort } from '../../../src/main/toolkit-run-port.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitMetricsSnapshot } from '@agentmux/core/control'

const [mode, directory, asset] = process.argv.slice(2)
assert.ok(mode && directory && asset, 'Private case identity is required')
const file = join(directory!, 'receipts.json'), log = join(directory!, 'native.jsonl')
const request = <T extends 'toolkit.get' | 'toolkit.run' | 'toolkit.stop'>(operation: T, toolId = 'performance') =>
  ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'private-proof', operation, toolId })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] } }
let opens = 0
const record = (operation: string, target: unknown) => appendFileSync(log, JSON.stringify({ operation, target, pid: process.pid }) + '\n')
const run = (runId = 'private-performance-run') => ({ runId, pid: 0, kind: 'terminal', state: 'running', latestOutputBytes: 0,
  firstAvailableByte: 0, acceptedInputBytes: 0, cols: 80, rows: 24, observedAt: 1000 } as any)
function port(create: ToolkitRunPort['create'] = async input => { record('create', input.createOperationId); return run() }): ToolkitRunPort {
  return { create, attach: async ref => ({ run: run(ref.runId), replay: [], gap: null } as any),
    replay: async ref => ({ run: run(ref.runId), replay: [], gap: null } as any),
    stop: async ref => { record('stop', ref.runId) }, release: async ref => { record('release', ref.runId) },
    remove: async ref => { record('remove', ref.runId) } }
}
const launch = () => ({ runner: process.execPath, cli: 'unused-private-cli', script: asset!, cwd: directory!, env: {} })
const store = (ids = ['performance']) => new ToolkitReceiptStore(file, () => ids)
function performance(p: ToolkitRunPort, receipts: Pick<ToolkitReceiptStore, 'read' | 'save'> = store()) {
  return new PerformanceToolkitOwner({ openRunPort: async () => { opens++; return p }, launch, enabled: () => true, receipts })
}
const get = async (owner: PerformanceToolkitOwner | ToolkitOwner) => {
  const result = await owner.execute(request('toolkit.get'), new AbortController().signal)
  assert.equal(result.operation, 'toolkit.get'); return (result as any).snapshot as ToolkitMetricsSnapshot
}
const tool = (id: string) => ({ id, revision: 'private-revision', name: id, icon: 'terminal', enabled: true,
  statusBar: 'icon' as const, workspacePath: directory!, script: "console.log('private')", args: [] })
function toolkit(ids: string[], p: ToolkitRunPort) {
  const value = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: ids.map(tool) } }
  const config = new ConfigOwner({ read: () => value, save: async next => next, publish: () => {} })
  return new ToolkitOwner({ config, receiptPath: file, launch, enabled: () => true,
    openRunPort: async () => { opens++; return p } })
}
const first = () => JSON.parse(readFileSync(join(directory!, 'first.json'), 'utf8'))
const signal = () => new AbortController().signal
let result: unknown

if (mode === 'unknown-first') {
  const owner = toolkit([], port(async input => { record('create', input.createOperationId); throw new Error('original creation receipt lost') }))
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), /original creation receipt lost/)
  const snapshot = await get(owner)
  assert.equal(snapshot.state, 'unknown'); assert.ok(snapshot.executionId); assert.equal(snapshot.run, null)
  assert.equal(snapshot.reason, 'original creation receipt lost')
  await owner.dispose()
  assert.equal(calls().filter(c => c.operation === 'create').length, 1)
  result = { pid: process.pid, snapshot }
  writeFileSync(join(directory!, 'first.json'), JSON.stringify(result))
} else if (mode === 'unknown-restore' || mode === 'binding-restore') {
  const owner = toolkit([], port())
  const snapshot = await get(owner), previous = first()
  assert.notEqual(process.pid, previous.pid, 'Owner reconstruction must use an independent Node process')
  assert.equal(snapshot.state, 'unknown', 'Restored admission must never become an empty idle owner')
  assert.equal(snapshot.executionId, previous.snapshot.executionId, 'Restore must retain the original execution identity')
  assert.equal(snapshot.run, null)
  if (mode === 'unknown-restore') assert.equal(snapshot.reason, previous.snapshot.reason)
  else assert.match(snapshot.reason!, /needs confirmation/, 'Missing unacknowledged binding must stay unknown')
  await assert.rejects(owner.subscribe('performance', () => {}, () => {}, signal()), { code: 'CONTROL_UNAVAILABLE' })
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), { code: 'CONTROL_UNAVAILABLE' })
  const stopped = await owner.execute(request('toolkit.stop'), signal())
  assert.equal((stopped as any).snapshot.executionId, snapshot.executionId)
  assert.equal((stopped as any).snapshot.state, 'unknown')
  assert.equal(opens, 0, 'Unconfirmed creation without a Run must not acquire a native port')
  assert.equal(calls().filter(c => c.operation === 'create').length, 1, 'Restore cannot repeat native creation')
  await owner.dispose(); result = { pid: process.pid, snapshot }
} else if (mode === 'binding-first') {
  const real = store(); let saves = 0
  const owner = performance(port(), { read: id => real.read(id), save: async (id, receipt) => {
    if (++saves === 2) throw new Error('Run binding save was not acknowledged')
    await real.save(id, receipt)
  } })
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), /binding save/)
  const snapshot = await get(owner), persisted = await store().read('performance') as any
  assert.equal(snapshot.state, 'unknown'); assert.ok(snapshot.run)
  assert.equal(persisted.admission.executionId, snapshot.executionId)
  assert.equal(persisted.admission.run, null, 'Failed binding write must retain the last acknowledged receipt')
  assert.equal(persisted.admission.reason, null)
  assert.equal(calls().filter(c => c.operation === 'create').length, 1)
  assert.equal(calls().filter(c => c.operation !== 'create').length, 0, 'Binding write failure cannot pretend cleanup completed')
  result = { pid: process.pid, snapshot }; writeFileSync(join(directory!, 'first.json'), JSON.stringify(result))
} else if (mode === 'cleanup-first') {
  const p = port(); p.remove = async ref => { record('remove', ref.runId); throw new Error('original exact removal unconfirmed') }
  const owner = toolkit([], p)
  await owner.execute(request('toolkit.run'), signal())
  await owner.execute(request('toolkit.stop'), signal())
  const snapshot = await get(owner)
  assert.equal(snapshot.state, 'unknown'); assert.equal(snapshot.run?.runId, 'private-performance-run')
  assert.match(snapshot.reason!, /original exact removal unconfirmed/)
  const persisted = await store().read('performance') as any
  assert.equal(persisted.admission.reason, snapshot.reason, 'Acknowledged failure reason must survive reconstruction')
  result = { pid: process.pid, snapshot }; writeFileSync(join(directory!, 'first.json'), JSON.stringify(result))
} else if (mode === 'cleanup-restore') {
  const owner = toolkit([], port()), previous = first(), snapshot = await get(owner)
  assert.notEqual(process.pid, previous.pid); assert.equal(snapshot.executionId, previous.snapshot.executionId)
  assert.deepEqual(snapshot.run, previous.snapshot.run); assert.equal(snapshot.reason, previous.snapshot.reason)
  await assert.rejects(owner.subscribe('performance', () => {}, () => {}, signal()), { code: 'CONTROL_UNAVAILABLE' })
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), { code: 'CONTROL_UNAVAILABLE' })
  assert.equal(opens, 0, 'Readonly restored admission must not stop or create a Run')
  const before = calls().length
  await owner.execute(request('toolkit.stop'), signal())
  assert.deepEqual(calls().slice(before).map(c => [c.operation, c.target]),
    [['stop','private-performance-run'],['release','private-performance-run'],['remove','private-performance-run']])
  assert.equal((await get(owner)).state, 'paused')
  assert.equal((await store().read('performance') as any).admission, null)
  await owner.execute(request('toolkit.run'), signal())
  assert.notEqual((await get(owner)).executionId, snapshot.executionId)
  assert.equal(calls().filter(c => c.operation === 'create').length, 2, 'Only a new explicit request after acknowledged cleanup admits a new creation')
  await owner.dispose(); result = { pid: process.pid, snapshot }
} else if (mode === 'directory-sync' || mode === 'directory-shared' || mode === 'directory-explicit-clear') {
  const original = fs.open; let failures = 0
  fs.open = (async (path: any, flags: any, ...rest: any[]) => {
    const handle = await (original as any)(path, flags, ...rest)
    if (String(path) === directory && flags === 'r') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { if (failures++ === 0) throw Object.assign(new Error('private parent sync failure'), { code: 'EIO' }); await sync() }
    }
    return handle
  }) as any
  syncBuiltinESMExports()
  const ids = mode === 'directory-shared' ? ['custom-a', 'custom-b'] : []
  const owner = toolkit(ids, ids.length ? port(async input => {
    record('create', input.createOperationId); throw new Error('private Custom creation receipt lost')
  }) : port())
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), /parent sync failure/, 'Directory fsync failure must reject the durable admission')
  const snapshot = await get(owner)
  assert.equal(opens, 0, 'Native port must not be acquired before a complete admission ACK')
  assert.equal(calls().length, 0, 'Directory sync failure must prevent native creation')
  assert.equal(snapshot.state, 'unknown'); assert.match(snapshot.reason!, /parent sync failure/)
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(disk.tools.performance.admission.executionId, snapshot.executionId, 'Rename can be visible without a durable ACK')
  fs.open = original; syncBuiltinESMExports()
  if (ids.length) {
    // Successful Custom writes after an unacknowledged rename must read back that file,
    // preserve Performance's admission, and keep the original Custom receipts intact.
    const writes = await Promise.allSettled(ids.map(id => owner.execute({ ...request('toolkit.run', id), input: {
      invocationId: 'private-' + id, expectedRevision: 'private-revision', expectedLatestExecutionId: null } }, signal())))
    for (const write of writes) {
      assert.equal(write.status, 'fulfilled')
      if (write.status === 'fulfilled') {
        assert.equal((write.value as any).snapshot.state, 'unknown')
        assert.match((write.value as any).snapshot.reason, /private Custom creation receipt lost/)
      }
    }
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(after.tools.performance, 'Subsequent Custom writes must retain the renamed unconfirmed admission')
    assert.equal(after.tools.performance.admission.executionId, snapshot.executionId,
      'Subsequent Custom writes must retain the renamed unconfirmed admission')
    for (const id of ids) assert.ok(after.tools[id].admission, 'Custom admission must remain intact: ' + id)
    assert.equal((await get(owner)).state, 'unknown')
  }
  if (mode === 'directory-explicit-clear') {
    await owner.execute(request('toolkit.stop'), signal())
    assert.equal((await get(owner)).state, 'paused', 'Explicit stop may clear only a proven undispatched admission after a durable ACK')
    assert.equal((await store().read('performance') as any).admission, null)
    assert.equal(opens, 0); assert.equal(calls().length, 0)
  }
  await owner.dispose()
  result = { pid: process.pid, snapshot }; writeFileSync(join(directory!, 'first.json'), JSON.stringify(result))
} else if (mode === 'directory-cleared-restore') {
  const owner = toolkit([], port()), snapshot = await get(owner)
  assert.notEqual(process.pid, first().pid)
  assert.equal(snapshot.state, 'idle'); assert.equal(snapshot.executionId, null)
  assert.equal((await store().read('performance') as any).admission, null)
  assert.equal(opens, 0); assert.equal(calls().length, 0)
  await owner.dispose(); result = { pid: process.pid, snapshot }
} else if (mode === 'directory-restore' || mode === 'directory-shared-restore') {
  const ids = mode === 'directory-shared-restore' ? ['custom-a', 'custom-b'] : []
  const owner = toolkit(ids, port()), snapshot = await get(owner)
  assert.notEqual(process.pid, first().pid)
  assert.equal(snapshot.state, 'unknown'); assert.equal(snapshot.executionId, first().snapshot.executionId)
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), { code: 'CONTROL_UNAVAILABLE' })
  assert.equal(opens, 0)
  assert.equal(calls().filter(c => c.operation === 'create').length, ids.length,
    'Reconstruction must not repeat the unconfirmed Performance creation')
  await owner.dispose(); result = { pid: process.pid, snapshot }
} else if (mode === 'load-failure') {
  const original = fs.stat
  fs.stat = (async (path: any, ...rest: any[]) => { if (String(path) === file) throw Object.assign(new Error('private receipt read denied'), { code: 'EACCES' }); return (original as any)(path, ...rest) }) as any
  syncBuiltinESMExports()
  const owner = toolkit([], port())
  assert.equal((await get(owner)).state, 'unknown'); assert.match((await get(owner)).reason!, /read denied/)
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), { code: 'CONTROL_UNAVAILABLE' })
  await assert.rejects(owner.subscribe('performance', () => {}, () => {}, signal()), { code: 'CONTROL_UNAVAILABLE' })
  assert.equal(opens, 0); assert.equal(calls().length, 0)
  fs.stat = original; syncBuiltinESMExports(); await owner.dispose(); result = { passed: true }
} else if (mode === 'undispatched-clear') {
  const real = store(); let admitRefused = false, clearRefused = false, saves = 0
  const owner = performance(port(), { read: id => real.read(id), save: async (id, receipt: any) => {
    saves++
    if (receipt.admission !== null && !admitRefused) { admitRefused = true; throw new Error('private admission save refused') }
    if (receipt.admission === null && !clearRefused) { clearRefused = true; throw new Error('private explicit clear refused') }
    await real.save(id, receipt)
  } })
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), /admission save refused/)
  const snapshot = await get(owner)
  assert.equal(snapshot.state, 'unknown'); assert.ok(snapshot.executionId); assert.equal(opens, 0)
  await owner.execute(request('toolkit.stop'), signal())
  assert.equal((await get(owner)).state, 'unknown'); assert.equal((await get(owner)).executionId, snapshot.executionId)
  assert.match((await get(owner)).reason!, /explicit clear refused/)
  assert.equal(saves, 2, 'Only an explicit stop may clear a provably undispatched admission')
  await assert.rejects(owner.subscribe('performance', () => {}, () => {}, signal()), { code: 'CONTROL_UNAVAILABLE' })
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), { code: 'CONTROL_UNAVAILABLE' })
  assert.equal(saves, 2); assert.equal(opens, 0); assert.equal(calls().length, 0)
  await owner.execute(request('toolkit.stop'), signal())
  assert.equal((await get(owner)).state, 'paused'); assert.equal((await store().read('performance') as any).admission, null)
  await owner.execute(request('toolkit.run'), signal())
  assert.notEqual((await get(owner)).executionId, snapshot.executionId)
  assert.equal(calls().filter(c => c.operation === 'create').length, 1)
  await owner.dispose(); result = { passed: true }
} else if (mode === 'clear-failure') {
  const real = store(); let refused = false
  const owner = performance(port(), { read: id => real.read(id), save: async (id, receipt: any) => {
    if (receipt.admission === null && !refused) { refused = true; throw new Error('receipt clear not acknowledged') }
    await real.save(id, receipt)
  } })
  await owner.execute(request('toolkit.run'), signal()); await owner.execute(request('toolkit.stop'), signal())
  const snapshot = await get(owner)
  assert.equal(snapshot.state, 'unknown'); assert.ok(snapshot.run); assert.ok((await store().read('performance') as any).admission)
  const before = calls().length
  await assert.rejects(owner.subscribe('performance', () => {}, () => {}, signal()), { code: 'CONTROL_UNAVAILABLE' })
  assert.equal(calls().length, before, 'A rejected consumer must not retry unknown cleanup')
  await owner.execute(request('toolkit.stop'), signal())
  assert.equal((await get(owner)).state, 'paused'); assert.equal(calls().length, before, 'Explicit receipt clear must not repeat confirmed native cleanup')
  assert.equal((await store().read('performance') as any).admission, null)
  await owner.dispose(); result = { passed: true }
} else if (/^(cancel|dispose)-(save|create)$/u.test(mode!)) {
  const [action, stage] = mode!.split('-'), real = store()
  let release!: () => void, reached = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const p = port(async input => { record('create', input.createOperationId); if (stage === 'create') { reached = true; await gate } return run() })
  p.attach = async ref => { record('attach', ref.runId); return { run: run(ref.runId), replay: [], gap: null } as any }
  const receipts = { read: (id: string) => real.read(id), save: async (id: string, receipt: any) => {
    if (stage === 'save' && !reached && receipt.admission !== null) { reached = true; await gate }
    await real.save(id, receipt)
  } }
  const owner = performance(p, receipts), controller = new AbortController()
  const pending = owner.subscribe('performance', () => {}, () => {}, controller.signal)
  while (!reached) await tick()
  let disposed = false
  let disposal: Promise<void> | null = null
  if (action === 'cancel') controller.abort()
  else {
    disposal = owner.dispose().then(() => { disposed = true })
    await tick(); assert.equal(disposed, false, 'Disposal must wait for the original pending admission or creation')
  }
  release(); (await pending).dispose()
  if (disposal) await disposal
  else {
    const deadline = Date.now() + 5000
    while ((await get(owner)).state !== 'paused' && Date.now() < deadline) await tick()
    assert.equal(disposed, false, 'Cancellation must settle while the owner remains open')
  }
  const native = calls()
  if (stage === 'save') assert.equal(native.length, 0, 'Cancellation before dispatch must not create a late Run')
  else assert.deepEqual(native.map(c => [c.operation, c.operation === 'create' ? 'original' : c.target]),
    [['create','original'],['stop','private-performance-run'],['release','private-performance-run'],['remove','private-performance-run']])
  assert.equal((await get(owner)).state, 'paused'); assert.equal((await get(owner)).consumerCount, 0)
  assert.equal((await store().read('performance') as any).admission, null)
  if (action === 'cancel') await owner.dispose()
  result = { passed: true }
} else if (mode === 'shared' || mode === 'budget') {
  const ids = mode === 'budget' ? Array.from({ length: 128 }, (_, i) => 'user-' + i) : ['custom-a', 'custom-b']
  const original = ToolkitReceiptStore.prototype.save, instances = new Set<ToolkitReceiptStore>(), captured = new Map<string, unknown>()
  ToolkitReceiptStore.prototype.save = async function(id, receipt) {
    instances.add(this); captured.set(id, structuredClone(receipt)); return await original.call(this, id, receipt)
  }
  const owner = toolkit(ids, port(async input => { record('create', input.createOperationId); throw new Error('private create receipt lost') }))
  if (mode === 'shared') {
    await Promise.allSettled([owner.execute(request('toolkit.run'), signal()), ...ids.map(id => owner.execute({ ...request('toolkit.run', id), input: { invocationId: 'private-' + id, expectedRevision: 'private-revision', expectedLatestExecutionId: null } }, signal()))])
  } else {
    await assert.rejects(owner.execute(request('toolkit.run'), signal()))
    assert.equal(instances.size, 1)
    const shared = [...instances][0]!
    await Promise.all(ids.map(id => shared.save(id, { admission: null, latestConfirmed: null })))
  }
  assert.equal(instances.size, 1, 'Performance and Custom must use one existing receipt write queue')
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Object.hasOwn(disk.tools, 'performance'), 'Custom writes must retain the pending built-in Performance admission')
  assert.equal(Object.keys(disk.tools).length, ids.length + 1, 'One built-in receipt must not shrink the 128-user budget')
  const restored = store(['performance', ...ids])
  for (const id of ['performance', ...ids]) assert.deepEqual(await restored.read(id), captured.get(id), 'Concurrent receipt must survive unchanged: ' + id)
  ToolkitReceiptStore.prototype.save = original; await owner.dispose(); result = { passed: true, records: Object.keys(disk.tools).length }
} else if (mode === 'corrupt') {
  const real = store(['performance','custom-a'])
  await real.save('performance', { invalid: true }); await real.save('custom-a', { admission: null, latestConfirmed: null })
  const owner = toolkit(['custom-a'], port())
  assert.equal((await get(owner)).state, 'unknown')
  const custom = await owner.execute(request('toolkit.get','custom-a'), signal())
  assert.equal((custom as any).snapshot.state, 'idle', 'Corrupt Performance cannot overwrite another healthy tool')
  await assert.rejects(owner.execute(request('toolkit.run'), signal()), { code: 'CONTROL_UNAVAILABLE' })
  assert.equal(opens, 0); assert.equal(calls().length, 0); await owner.dispose(); result = { passed: true }
} else throw new Error('Unknown private case: ' + mode)
console.log(JSON.stringify({ completed: true, mode, result }))
