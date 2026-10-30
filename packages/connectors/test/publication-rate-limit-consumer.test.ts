import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import type { PublicationOperation } from '../src/publication-store.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import type { RoomBinding } from '../../core/src/connections.js'
import { context } from './fixtures/room-binding.js'
import * as core from '../../core/src/index.js'
import { closes, fixture, native, append, imageBlock, imageOperation, imageWrites } from './fixtures/publication-source-owner.js'

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const image = (body: Record<string, unknown>) => typeof body.content === 'string' && body.content.includes('img_key')

it.each([
  { name: 'native gateway reset', code: 99991400, status: 429, reset: '2', basis: 'native' },
  { name: 'local native group limit', code: 230020, status: 400, basis: 'local' },
  { name: 'invalid native reset', code: 99991400, status: 429, reset: 'not-a-duration', basis: 'local' }
] as const)('original $name automatically resumes once and public SDK/Hosted/compiled CLI read the same wait', async limited => {
  const f = await fixture(); let first = true
  f.remote.controls.messageResponse = attempt => image(attempt.body) && first
    ? (first = false, { code: limited.code, status: limited.status, ...('reset' in limited ? { reset: limited.reset } : {}) }) : undefined
  await append(f, native('rate-limit-' + limited.basis, [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!, request = { operationId: original.operationId }
  const sdk = (await f.managed.call('connection.delivery.inspect', request)).delivery!
  expect(sdk).toMatchObject({ state: 'not-applied', retrySource: { kind: 'message', attempt: 1 },
    wait: { reason: 'rate-limit', basis: limited.basis, notBefore: expect.any(Number) } })
  const hosted = await core.connectHostedAgentMux({ rpc: f.rpc, waitForReady: false,
    forwardRpc: (method, params, context = {}) => f.rpc.call(method, params, { ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}), ...(context.signal ? { signal: context.signal } : {}) }) })
  closes.push(() => hosted.dispose())
  expect((await hosted.forwardRpc!('connection.delivery.inspect', request)).delivery?.wait).toEqual(sdk.wait)
  expect((await f.cli(original.operationId)).delivery.wait).toEqual(sdk.wait)
  const page = { connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision }
  expect((await f.managed.call('connection.delivery.ls', page)).deliveries.find(value => value.operationId === original.operationId)?.wait).toEqual(sdk.wait)
  expect((await hosted.forwardRpc!('connection.delivery.ls', page)).deliveries.find(value => value.operationId === original.operationId)?.wait).toEqual(sdk.wait)
  const cliPage = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.root, 'images.sock'), 'connection', 'delivery', 'ls', '--connection', page.connectionId, '--binding', page.bindingId, '--binding-revision', String(page.bindingRevision)], objectCliEnvironment(f.root))
  expect(cliPage.code, cliPage.stderr + cliPage.stdout).toBe(0)
  expect(JSON.parse(cliPage.stdout).result.deliveries.find((value: { operationId: string }) => value.operationId === original.operationId)?.wait).toEqual(sdk.wait)

  expect(JSON.stringify(sdk)).not.toMatch(/scopeKey|rateLimitScopes|x-ogw-ratelimit|fixture-image-access/u)
  await pause(500)
  expect(imageWrites(f)).toHaveLength(1)
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('confirmed'), { timeout: 13_000 })
  const final = imageOperation(f)!, attempts = f.remote.attempts.filter(attempt => image(attempt.body))
  expect(attempts).toHaveLength(2); expect(attempts[1]!.at).toBeGreaterThanOrEqual(sdk.wait!.notBefore)
  expect(attempts[1]!.elapsed - attempts[0]!.elapsed).toBeGreaterThanOrEqual(limited.basis === 'local' ? 4_900 : 1_900)
  expect(final.continuations).toMatchObject([{ source: { kind: 'message', attempt: 1 } }])
  expect(final.attempt).toBe(2); expect(final.prepared).toEqual(original.prepared); expect(final.target).toEqual(original.target)
  expect(f.remote.uploads).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)


type Fixture = Awaited<ReturnType<typeof fixture>>
const images = (f: Fixture, binding: RoomBinding = f.binding) => f.services.publication!.store.list(binding, 100).filter(op => op.payload.kind === 'image')
async function bind(f: Fixture, id: string, room: string, app?: string) {
  const connectionId = 'connection-' + id
  const original = (await f.services.connections.list()).connections.find(record => record.config.connectionId === f.binding.connectionId)!.config
  await f.services.connections.configure({ operationId: 'configure-' + id, expectedRevision: null,
    connection: { ...original, connectionId, application: { ...original.application, ...(app ? { appId: app } : {}) } } })
  const result = await f.services.connections.bindings!.bind({ ...f.input, operationId: 'bind-' + id, bindingId: id,
    connectionId, externalConversationId: room, expectedConnectionRevision: 1 }, context)
  expect(result.state).toBe('applied')
  if (result.state !== 'applied') throw Error('Original Binding required')
  return result.binding
}
async function measurement(name: string, value: unknown) {
  if (process.env.PUBLICATION_RATE_LIMIT_MEASUREMENTS) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(process.env.PUBLICATION_RATE_LIMIT_MEASUREMENTS, JSON.stringify({ name, value }) + '\n')
  }
}

it('shared native group gates two applications and new first messages while independent groups progress, then expiry burst stays bounded', async () => {
  const f = await fixture(); let groupFailures = 0
  f.remote.controls.messageResponse = attempt => {
    if (image(attempt.body) && attempt.room === f.binding.externalConversationId && groupFailures < 2) {
      groupFailures++; return { code: 230020, status: 400, reset: '4' }
    }
  }
  await append(f, native('group-original', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!, firstWait = f.services.publication!.store.delivery(original).wait!
  const second = await bind(f, 'same-group-other-app', f.binding.externalConversationId, 'cli_fedcba9876543210')
  const independent = await bind(f, 'independent-group', 'other-native-group')
  await append(f, native('group-new-first-messages', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(images(f, independent).some(op => op.state === 'confirmed')).toBe(true), { timeout: 3_000 })
  await vi.waitFor(() => expect(images(f, second)).toHaveLength(1), { timeout: 3_000 })
  await pause(300)
  const preDeadline = f.remote.attempts.filter(attempt => image(attempt.body) && attempt.room === f.binding.externalConversationId)
  expect(preDeadline, 'same native group must not split by app or bypass cooling for unprepared first messages').toHaveLength(1)
  expect(images(f, second)[0]).toMatchObject({ state: 'pending', prepared: expect.any(Object) })
  expect(images(f, second)[0]!.attempt).toBeUndefined()
  expect(f.services.publication!.store.delivery(images(f, second)[0]!).wait).toEqual(firstWait)
  expect(f.remote.attempts.find(attempt => image(attempt.body) && attempt.room === independent.externalConversationId)!.at).toBeLessThan(firstWait.notBefore)
  await vi.waitFor(() => {
    expect(images(f)).toHaveLength(2); expect(images(f).every(op => op.state === 'confirmed')).toBe(true)
    expect(images(f, second).every(op => op.state === 'confirmed')).toBe(true)
  }, { timeout: 23_000 })
  const writes = f.remote.attempts.filter(attempt => image(attempt.body) && attempt.room === f.binding.externalConversationId)
  expect(writes.slice(1).every(attempt => attempt.at >= firstWait.notBefore)).toBe(true)
  expect(new Set(writes.map(attempt => attempt.application)).size).toBe(2)
  expect(writes).toHaveLength(5) // three original messages, two actual no-effect 429s
  const after = images(f).find(op => op.operationId === original.operationId)!
  expect(after.prepared).toEqual(original.prepared); expect(after.target).toEqual(original.target)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await measurement('shared-group-burst', { attempts: writes, extra429: groupFailures - 1,
    completionMs: writes.at(-1)!.elapsed - writes[0]!.elapsed, independentBeforeDeadline: true })
}, 35_000)

it('native gateway scope cools its original application and API while another application progresses in the same group', async () => {
  const f = await fixture(); let first = true
  f.remote.controls.messageResponse = attempt => image(attempt.body) && first
    ? (first = false, { code: 99991400, status: 400, reset: '4' }) : undefined
  await append(f, native('gateway-original', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!, wait = f.services.publication!.store.delivery(original).wait!
  const sameAppOtherGroup = await bind(f, 'gateway-same-app', 'gateway-other-group')
  const otherApp = await bind(f, 'gateway-other-app', f.binding.externalConversationId, 'cli_1111222233334444')
  await append(f, native('gateway-new-scope-messages', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(images(f, otherApp).some(op => op.state === 'confirmed')).toBe(true), { timeout: 3_000 })
  expect(f.remote.attempts.filter(attempt => image(attempt.body) && attempt.application === f.binding.application.appId)).toHaveLength(1)
  expect(f.remote.attempts.find(attempt => image(attempt.body) && attempt.application === otherApp.application.appId)!.at).toBeLessThan(wait.notBefore)
  expect(images(f, sameAppOtherGroup)[0], 'separate native upload API must prepare the blocked application message before its send window').toMatchObject({ state: 'pending', prepared: expect.any(Object) })
  expect(images(f, sameAppOtherGroup)[0]!.attempt).toBeUndefined()
  await vi.waitFor(() => expect(images(f, sameAppOtherGroup).every(op => op.state === 'confirmed') && images(f, sameAppOtherGroup).length === 1).toBe(true), { timeout: 13_000 })
  expect(f.remote.attempts.filter(attempt => image(attempt.body) && attempt.application === f.binding.application.appId).slice(1).every(attempt => attempt.at >= wait.notBefore)).toBe(true)
  expect(f.remote.uploads.length, 'independent upload API remains available').toBeGreaterThanOrEqual(3)
}, 25_000)

it('early accepted natural source edge survives lost reply, stale SDK Hosted CLI repeats and automatic competition without consuming the successor', async () => {
  const f = await fixture(); let failures = 0
  f.remote.controls.messageResponse = attempt => image(attempt.body) && failures < 2
    ? (failures++, { code: 230020, status: 400, reset: '2' }) : undefined
  await append(f, native('early-source-edge', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!, request = { operationId: original.operationId, source: { kind: 'message' as const, attempt: 1 } }
  const host = f.services.publication!, call = host.retry.bind(host)
  vi.spyOn(host, 'retry').mockImplementationOnce(async (...args) => { await call(...args); throw new core.AgentMuxError('Lost reply after committed original edge', 'CONTROL_DISCONNECTED') })
  await expect(f.managed.call('connection.delivery.retry', request)).rejects.toMatchObject({ code: 'CONTROL_DISCONNECTED' })
  const accepted = host.store.inspect(original.operationId)!
  expect(accepted).toMatchObject({ state: 'pending', attempt: 1, continuations: [{ source: request.source }] })
  const edge = accepted.continuations![0]!
  const repeated = await f.managed.call('connection.delivery.retry', request)
  expect(repeated.continuation).toEqual(edge); expect(repeated.delivery.wait).toEqual(host.store.delivery(original).wait)
  const cli = await f.retryCli(request); expect(cli.code, cli.stderr + cli.stdout).toBe(0)
  expect(imageWrites(f)).toHaveLength(1)
  await vi.waitFor(() => expect(imageOperation(f)).toMatchObject({ state: 'not-applied', attempt: 2 }), { timeout: 13_000 })
  const hosted = await core.connectHostedAgentMux({ rpc: f.rpc, waitForReady: false,
    forwardRpc: (method, params, context = {}) => f.rpc.call(method, params, { ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}) }) })
  closes.push(() => hosted.dispose())
  const repeats = await Promise.allSettled([f.managed.call('connection.delivery.retry', request), hosted.forwardRpc!('connection.delivery.retry', request), f.retryCli(request)])
  expect(imageOperation(f)!.continuations, 'old source must not consume the newly failed source2').toHaveLength(1)
  expect(imageWrites(f)).toHaveLength(2)
  for (const result of repeats) expect(result.status).toBe('fulfilled')
  const fresh = { operationId: original.operationId, source: { kind: 'message' as const, attempt: 2 } }
  const next = await f.managed.call('connection.delivery.retry', fresh)
  expect(next.delivery).toMatchObject({ state: 'pending', wait: { reason: 'rate-limit' } })
  await vi.waitFor(() => expect(imageOperation(f)).toMatchObject({ state: 'confirmed', attempt: 3 }), { timeout: 13_000 })
  const final = imageOperation(f)!
  expect(final.continuations).toMatchObject([{ source: request.source }, { source: fresh.source }])
  expect(final.prepared).toEqual(original.prepared); expect(final.target).toEqual(original.target)
  expect(imageWrites(f)).toHaveLength(3); expect(f.remote.uploads).toHaveLength(1)
  expect((await f.managed.call('connection.delivery.retry', request)).continuation.source).toEqual(request.source)
}, 35_000)

it('rate-limit original cooling and source edge survive a real owner SIGKILL and same database reopen before the next claim', async () => {
  const { spawn } = await import('node:child_process')
  const f = await fixture(); let limited = true
  f.remote.controls.messageResponse = attempt => image(attempt.body) && limited ? (limited = false, { code: 230020, status: 400, reset: '15' }) : undefined
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
  expect(committed!.retained.rateLimit).toEqual(original.rateLimit)
  expect(Date.now()).toBeLessThan(observed.wait!.notBefore)
  await kill()
  const lost = await cli
  expect(lost.code).not.toBe(0)
  await f.restart(); f.services.publication!.refresh()
  expect(f.services.publication!.store.delivery(f.services.publication!.store.inspect(original.operationId)!).wait).toEqual(observed.wait)
  await pause(500); expect(imageWrites(f)).toHaveLength(1)
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'confirmed', attempt: 2 }), { timeout: 23_000 })
  expect(f.remote.attempts.filter(attempt => image(attempt.body))[1]!.at).toBeGreaterThanOrEqual(observed.wait!.notBefore)
  const duplicate = await f.managed.call('connection.delivery.retry', request)
  expect(duplicate.continuation).toEqual(committed!.accepted.continuation)
  expect((await f.retryCli(request)).code).toBe(0)
  const after = f.services.publication!.store.inspect(original.operationId)!
  expect(after.prepared).toEqual(original.prepared); expect(after.target).toEqual(original.target)
  expect(after.payload).toEqual(original.payload); expect(imageWrites(f)).toHaveLength(2); expect(f.remote.uploads).toHaveLength(1)
  expect(f.client.agentSession('original-agent').run).toEqual(originalSession.run)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  if (process.env.PUBLICATION_RATE_LIMIT_CRASH_EVIDENCE) await writeFile(process.env.PUBLICATION_RATE_LIMIT_CRASH_EVIDENCE, JSON.stringify({ child: ready, committed, signal: child.signalCode, lost, after, duplicate, originalSession, sessionAfter: f.client.agentSession('original-agent'), writes: imageWrites(f) }, null, 2))
}, 40_000)


it.each([{ name: 'unknown', code: 230049, status: 400 }, { name: 'permanent', code: 230025, status: 400 }] as const)(
  'automatic recovery never claims a $name native result while healthy independent projections remain available', async response => {
  const f = await fixture()
  f.remote.controls.messageResponse = attempt => image(attempt.body) ? response : undefined
  await append(f, native('ineligible-' + response.name, [imageBlock(), { type: 'text', text: 'Healthy independent projection' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe(response.name === 'unknown' ? 'unknown' : 'not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!, delivery = f.services.publication!.store.delivery(original)
  expect(original.rateLimit).toBeUndefined(); expect(delivery.wait).toBeUndefined()
  await pause(5_500); f.services.publication!.refresh(); await pause(100)
  expect(imageWrites(f)).toHaveLength(1); expect(imageOperation(f)!.continuations ?? []).toHaveLength(0)
  expect(JSON.stringify(f.remote.calls)).toContain('Healthy independent projection')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it.each(['missing-preparation', 'revoked'] as const)('automatic recovery retains %s as ineligible after a real no-effect response', async fate => {
  const f = await fixture(); let first = true
  f.remote.controls.messageResponse = attempt => image(attempt.body) && first ? (first = false, { code: 230020, status: 400, reset: '1' }) : undefined
  await append(f, native('ineligible-' + fate, [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!, store = f.services.publication!.store
  if (fate === 'missing-preparation') {
    const { prepared: _prepared, ...retained } = original
    store.database.prepare('UPDATE connector_publication_operation SET operation_json=? WHERE operation_id=?').run(JSON.stringify(retained), original.operationId)
  } else await f.services.connections.bindings!.pause({ operationId: 'revoke-automatic-publication', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, context)
  await pause(5_500); f.services.publication!.refresh(); await pause(100)
  expect(imageWrites(f)).toHaveLength(1); expect(store.inspect(original.operationId)!.continuations ?? []).toHaveLength(0)
  expect(store.attempts(original.operationId)).toEqual([{ attempt: 1, receipt: original.receipt }])
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('real native long reset remains fixed across repeated reads and same DB reopen without clamping or a new effect', async () => {
  const f = await fixture()
  f.remote.controls.messageResponse = attempt => image(attempt.body) ? { code: 99991400, status: 429, reset: '7200' } : undefined
  await append(f, native('native-long-reset', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const original = imageOperation(f)!, wait = f.services.publication!.store.delivery(original).wait!
  expect(wait.basis).toBe('native'); expect(wait.notBefore - f.remote.attempts.find(attempt => image(attempt.body))!.at).toBeGreaterThanOrEqual(7_199_900)
  await pause(50); expect((await f.cli(original.operationId)).delivery.wait).toEqual(wait)
  await f.restart(); f.services.publication!.refresh(); await pause(300)
  const after = imageOperation(f)!
  expect(f.services.publication!.store.delivery(after).wait).toEqual(wait); expect(after.rateLimit).toEqual(original.rateLimit)
  expect(imageWrites(f)).toHaveLength(1); expect(after.continuations ?? []).toHaveLength(0)
}, 15_000)
