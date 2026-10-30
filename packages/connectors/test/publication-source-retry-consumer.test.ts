import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as core from '../../core/src/index.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import type { PublicationOperation } from '../src/publication-store.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { closes, fixture, native, append, imageBlock, posts, imageWrites, imageOperation } from './fixtures/publication-source-owner.js'
import { context } from './fixtures/room-binding.js'

async function settled(host: unknown) {
  for (;;) {
    const lanes = Reflect.get(host as object, 'lanes') as Map<string, { work?: Promise<unknown> }>
    const work = [...lanes.values()].flatMap(lane => lane.work ? [lane.work] : [])
    if (!work.length) return
    await Promise.all(work)
  }
}

it('source-qualified retry preserves one accepted action through SDK lost reply, Hosted forwarding and repeated compiled CLI', async () => {
  const f = await fixture()
  f.remote.controls.imageMessageFailures = [230020, 230020]
  await append(f, native('source-qualified-message', [imageBlock(), { type: 'text', text: 'Independent projection survives failed original message' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!
  const first = (await f.managed.call('connection.delivery.inspect', { operationId: original.operationId })).delivery!
  expect(first).toMatchObject({ state: 'not-applied', reason: 'rate-limited', retrySource: { kind: 'message', attempt: 1 } })
  const request = { operationId: first.operationId, source: first.retrySource! }
  const call = f.services.publication!.retry.bind(f.services.publication!)
  vi.spyOn(f.services.publication!, 'retry').mockImplementationOnce(async (...args) => { await call(...args); throw new core.AgentMuxError('Reply lost after durable source acceptance', 'CONTROL_DISCONNECTED') })
  await expect(f.managed.call('connection.delivery.retry', request)).rejects.toMatchObject({ code: 'CONTROL_DISCONNECTED' })
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'not-applied', attempt: 2 }), { timeout: 8_000 })
  const after = (await f.managed.call('connection.delivery.inspect', { operationId: original.operationId })).delivery!
  expect(after).toMatchObject({ retrySource: { kind: 'message', attempt: 2 }, lastContinuation: { source: request.source, acceptedAt: expect.any(Number) } })
  const hosted = await core.connectHostedAgentMux({ rpc: f.rpc, waitForReady: false,
    forwardRpc: (method, input, context = {}) => f.rpc.call(method, input, { ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}) }) })
  closes.push(() => hosted.dispose())
  const repeated = await Promise.allSettled([f.managed.call('connection.delivery.retry', request), hosted.forwardRpc!('connection.delivery.retry', request), f.rpc.call('connection.delivery.retry', request)])
  await settled(f.services.publication)
  expect(imageWrites(f), 'repeating accepted source1 must not create attempt3').toHaveLength(2)
  for (const result of repeated) { if (result.status === 'rejected') throw result.reason; expect(result.value).toMatchObject({ continuation: after.lastContinuation, delivery: { operationId: first.operationId, state: 'not-applied', retrySource: after.retrySource } }) }
  const cli = await f.retryCli(request)
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.continuation).toEqual(after.lastContinuation)
  expect(imageWrites(f), 'repeating accepted source1 must not create attempt3').toHaveLength(2)
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent projection survives failed original message'))
  const fresh = { operationId: original.operationId, source: after.retrySource! }
  const next = await f.retryCli(fresh)
  expect(next.code, next.stdout + next.stderr).toBe(0)
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'confirmed', attempt: 3 }), { timeout: 8_000 })
  const retained = f.services.publication!.store.inspect(original.operationId)!
  expect(retained.prepared).toEqual(original.prepared); expect(retained.payload).toEqual(original.payload)
  expect(retained.target).toEqual(original.target); expect(f.remote.uploads).toHaveLength(1)
  expect(imageWrites(f)).toHaveLength(3)
  const old = await f.managed.call('connection.delivery.retry', request)
  expect(old.continuation).toEqual(after.lastContinuation)
  expect(old.delivery.lastContinuation?.source).toEqual(fresh.source)
  expect(imageWrites(f)).toHaveLength(3)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it.each(['unknown', 'confirmed-before', 'confirmed-after', 'confirmed-prepared'] as const)('source-qualified upload continuation isolates late original %s without changing its message identity', async late => {
  const f = await fixture(); f.remote.controls.missingUploadKey = true
  await append(f, native('source-qualified-upload', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!, store = f.services.publication!.store
  const delivery = (await f.managed.call('connection.delivery.inspect', { operationId: original.operationId })).delivery!
  expect(delivery.retrySource).toEqual({ kind: 'content-upload', attempt: 1 })
  const request = { operationId: original.operationId, source: delivery.retrySource! }
  let blocked = true, release!: () => void
  const held = new Promise<void>(done => { release = done }); closes.push(() => release())
  const claim = store.claimResourceUpload.bind(store)
  vi.spyOn(store, 'claimResourceUpload').mockImplementation((...args) => blocked && args[0] === original.operationId ? null : claim(...args))
  const accepted = await f.managed.call('connection.delivery.retry', request)
  expect(accepted.continuation.source).toEqual(request.source)
  expect(store.inspect(original.operationId)).toMatchObject({ state: 'pending', uploads: [{ state: 'unknown' }] })
  f.remote.controls.missingUploadKey = false
  if (late === 'unknown' || late === 'confirmed-before') {
    store.settleResourceUpload(original.operationId, 1, late === 'unknown' ? { state: 'unknown' } : { state: 'confirmed', imageKey: 'original-image-key-1' })
    expect(store.inspect(original.operationId), 'old upload cannot undo a durably accepted pending continuation').toMatchObject({ state: 'pending' })
  }
  if (late === 'confirmed-after') f.remote.controls.beforeUpload = async (_bytes, index) => { if (index === 2) await held }
  blocked = false; f.services.publication!.refresh()
  if (late === 'confirmed-after') {
    await vi.waitFor(() => expect(f.remote.uploads).toHaveLength(2))
    store.settleResourceUpload(original.operationId, 1, { state: 'confirmed', imageKey: 'original-image-key-1' })
    expect(store.inspect(original.operationId)).toMatchObject({ state: 'pending', uploads: [{ state: 'confirmed' }, { state: 'dispatching' }] })
    release()
  }
  await vi.waitFor(() => expect(store.inspect(original.operationId)?.state).toBe('confirmed'), { timeout: 8_000 })
  const beforeLate = store.inspect(original.operationId)!
  if (late === 'confirmed-prepared') store.settleResourceUpload(original.operationId, 1, { state: 'confirmed', imageKey: 'original-image-key-1' })
  const final = store.inspect(original.operationId)!
  expect(final.prepared).toEqual(beforeLate.prepared); expect(final.mapping).toEqual(beforeLate.mapping)
  expect(imageWrites(f)).toHaveLength(1)
  expect(f.remote.uploads).toHaveLength(late === 'confirmed-before' ? 1 : 2)
  expect(JSON.stringify(imageWrites(f)[0]!.body)).toContain(late === 'confirmed-before' ? 'original-image-key-1' : 'original-image-key-2')
  const duplicate = await f.managed.call('connection.delivery.retry', request)
  expect(duplicate.continuation).toEqual(accepted.continuation)
  expect(duplicate.delivery).toMatchObject({ state: 'confirmed' }); expect(imageWrites(f)).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('source-qualified retry reads an old accepted edge after revocation but refuses a new effect source and invalid proposals', async () => {
  const f = await fixture(); f.remote.controls.imageMessageFailures = [230020, 230020]
  await append(f, native('source-qualified-authority', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!, selector = { operationId: original.operationId }
  const first = (await f.managed.call('connection.delivery.inspect', selector)).delivery!
  const request = { ...selector, source: first.retrySource! }
  for (const source of [{ kind: 'content-upload', attempt: 1 }, { kind: 'message', attempt: 2 }]) await expect(f.managed.call('connection.delivery.retry', { ...selector, source } as never)).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  for (const source of [undefined, { kind: 'message', attempt: 0 }, { kind: 'avatar', attempt: 1 }]) await expect(f.managed.call('connection.delivery.retry', { ...selector, source } as never)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_DELIVERY_DATA' })
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  const accepted = await f.managed.call('connection.delivery.retry', request)
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'not-applied', attempt: 2 }))
  const failed = (await f.managed.call('connection.delivery.inspect', selector)).delivery!
  await f.services.connections.bindings!.pause({ operationId: 'pause-before-new-source', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, context)
  const duplicate = await f.managed.call('connection.delivery.retry', request)
  expect(duplicate.continuation).toEqual(accepted.continuation)
  const before = f.services.publication!.store.inspect(original.operationId)!
  const denied = await f.managed.call('connection.delivery.retry', { ...selector, source: failed.retrySource! }).then(value => ({ value }), error => ({ error }))
  expect(f.services.publication!.store.inspect(original.operationId), 'revoked publication must not consume another source or change its queue fate').toEqual(before)
  expect(denied).toMatchObject({ error: { code: 'PUBLICATION_NOT_AUTHORIZED' } })
  expect(imageWrites(f)).toHaveLength(2); expect(before.continuations).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('source-qualified acceptance survives a real owner SIGKILL on the original database before its next effect claim', async () => {
  const { spawn } = await import('node:child_process')
  const f = await fixture(); f.remote.controls.imageMessageFailures = [230020]
  await append(f, native('source-qualified-process', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!, originalSession = f.client.agentSession('original-agent')
  const observed = (await f.managed.call('connection.delivery.inspect', { operationId: original.operationId })).delivery!
  const request = { operationId: original.operationId, source: observed.retrySource! }
  await f.services.close()
  const setup = join(f.root, 'private-publication-process.json'), witness = join(f.root, 'private-publication-witness.json')
  await writeFile(setup, JSON.stringify({ directory: join(f.root, 'image-host'), spatial: join(f.root, 'spatial.json'), operationId: original.operationId, witness, socketPath: join(f.root, 'crash-publication.sock') }))
  const child = spawn(process.execPath, [resolve('packages/connectors/test/fixtures/publication-source-crash-worker.mjs'), setup], { env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''; child.stderr!.on('data', bytes => { errors += String(bytes) })
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended } }
  closes.push(kill)
  const ready = await new Promise<{ socketPath: string; owner: unknown }>((yes, no) => {
    let output = ''; const timer = setTimeout(() => no(Error('Original publication child readiness: ' + errors)), 15_000)
    child.stdout!.on('data', bytes => { output += String(bytes); if (output.includes('\n')) { clearTimeout(timer); try { yes(JSON.parse(output.split('\n')[0]!)) } catch (error) { no(error) } } })
    child.once('exit', code => { clearTimeout(timer); no(Error('Original publication child exited ' + code + ': ' + errors)) })
  })
  const cli = runCompiledObjectCli(['--endpoint', 'unix:' + ready.socketPath, 'connection', 'delivery', 'retry', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(request))
  let committed: { pid: number; original: PublicationOperation; accepted: { continuation: unknown }; retained: PublicationOperation } | undefined
  await vi.waitFor(async () => { try { committed = JSON.parse(await readFile(witness, 'utf8')) } catch { if (child.exitCode !== null || child.signalCode !== null) throw Error(errors) }; expect(committed, errors).toBeDefined() }, { timeout: 8_000 })
  expect(committed!.original).toEqual(original)
  expect(committed!.retained).toMatchObject({ state: 'pending', attempt: 1, continuations: [{ source: request.source }] })
  expect(imageWrites(f)).toHaveLength(1)
  await kill()
  const lost = await cli
  expect(lost.code).not.toBe(0)
  await f.restart(); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'confirmed', attempt: 2 }), { timeout: 8_000 })
  const duplicate = await f.managed.call('connection.delivery.retry', request)
  expect(duplicate.continuation).toEqual(committed!.accepted.continuation)
  expect((await f.retryCli(request)).code).toBe(0)
  const after = f.services.publication!.store.inspect(original.operationId)!
  expect(after.prepared).toEqual(original.prepared); expect(after.target).toEqual(original.target)
  expect(after.payload).toEqual(original.payload); expect(imageWrites(f)).toHaveLength(2); expect(f.remote.uploads).toHaveLength(1)
  expect(f.client.agentSession('original-agent').run).toEqual(originalSession.run)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  if (process.env.PUBLICATION_SOURCE_RETRY_CRASH_EVIDENCE) await writeFile(process.env.PUBLICATION_SOURCE_RETRY_CRASH_EVIDENCE, JSON.stringify({ child: ready, committed, signal: child.signalCode, lost, after, duplicate, originalSession, sessionAfter: f.client.agentSession('original-agent'), writes: imageWrites(f) }, null, 2))
}, 40_000)

it('source-qualified receipt cannot reconstruct missing original message preparation', async () => {
  const f = await fixture(); f.remote.controls.imageMessageFailures = [230020]
  await append(f, native('source-qualified-missing-preparation', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!, store = f.services.publication!.store
  const { prepared: _prepared, ...withoutPreparation } = original
  store.database.prepare('UPDATE connector_publication_operation SET operation_json=? WHERE operation_id=?').run(JSON.stringify(withoutPreparation), original.operationId)
  const selected = { operationId: original.operationId }
  expect((await f.managed.call('connection.delivery.inspect', selected)).delivery?.retrySource).toBeUndefined()
  await expect(f.managed.call('connection.delivery.retry', { ...selected, source: { kind: 'message', attempt: 1 } })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(store.attempts(original.operationId)).toEqual([{ attempt: 1, receipt: original.receipt }])
  expect(imageWrites(f)).toHaveLength(1)
  await append(f, native('independent-after-unavailable-preparation', [{ type: 'text', text: 'Independent publication still works' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent publication still works'))
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('source-qualified preparation failure has no fabricated source while independent publication stays usable', async () => {
  const f = await fixture(), host = f.services.publication!
  const adapter: PublicationAdapter = Reflect.get(host, 'options').connections.publicationAdapter(f.binding.connectionId)
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(operation => { if (operation.payload.kind === 'image') throw Error('Original format is unavailable before message claim'); return prepare(operation) })
  await append(f, native('source-qualified-unclaimed', [imageBlock(), { type: 'text', text: 'Independent publication beside unprepared image' }]))
  host.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent publication beside unprepared image'))
  const original = imageOperation(f)!
  expect(original.attempt).toBeUndefined(); expect(original.prepared).toBeUndefined()
  const delivery = (await f.managed.call('connection.delivery.inspect', { operationId: original.operationId })).delivery!
  expect(delivery.retrySource).toBeUndefined()
  for (const kind of ['message', 'content-upload'] as const) await expect(f.managed.call('connection.delivery.retry', { operationId: original.operationId, source: { kind, attempt: 1 } })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(host.store.inspect(original.operationId)).toEqual(original)
  expect(imageWrites(f)).toHaveLength(0)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it.each(['cancelled', 'superseded'] as const)('source-qualified accepted upload remains an original read after its queue is %s', async fate => {
  const f = await fixture(); f.remote.controls.missingUploadKey = true
  await append(f, native('source-qualified-terminal', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!, store = f.services.publication!.store
  const first = (await f.managed.call('connection.delivery.inspect', { operationId: original.operationId })).delivery!
  const request = { operationId: original.operationId, source: first.retrySource! }
  vi.spyOn(store, 'claimResourceUpload').mockReturnValue(null)
  const accepted = await f.managed.call('connection.delivery.retry', request)
  if (fate === 'cancelled') store.retireBindingPending(f.binding)
  else {
    // Controlled authoritative queue-fate fixture, independent of the producer's revision algorithm.
    store.database.prepare("UPDATE connector_publication_operation SET state=?, operation_json=json_set(operation_json,'$.state',?) WHERE operation_id=?").run(fate, fate, original.operationId)
  }
  const before = store.inspect(original.operationId)!
  expect(before.state).toBe(fate)
  const observed = await f.managed.call('connection.delivery.retry', request)
  expect(observed).toMatchObject({ continuation: accepted.continuation, delivery: { state: fate } })
  await expect(f.managed.call('connection.delivery.retry', { ...request, source: { kind: 'content-upload', attempt: 2 } })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(store.inspect(original.operationId)).toEqual(before)
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(0)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)
