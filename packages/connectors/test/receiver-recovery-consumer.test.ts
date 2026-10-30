import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { connectAgentMuxRpc } from '../../core/src/index.js'
import { receiverRecoveryFixture, waitReceiver } from './fixtures/receiver-recovery.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const result = (r: { code: number | null; stdout: string; stderr: string }) => { expect(r.code, r.stdout + r.stderr).toBe(0); return JSON.parse(r.stdout).result }

it('pure compiled CLI discovers the original Runtime before same-receiver recovery and inspection', async () => {
  const f = await receiverRecoveryFixture(cleanup, { endpointCode: 514 })
  await waitReceiver(async () => expect((await f.current()).receiver?.state).toBe('ended'))
  expect(result(await f.rootCli(['connection', 'owner', 'inspect'])).ownership).toBe('local')
  const { owner } = result(await f.rootCli(['runtime', 'owner', 'identity']))
  const connection = result(await f.rootCli(['connection', 'inspect', '--connection', 'feishu-connection'])).connection
  const input = { operationId: 'pure-cli-original', connectionId: connection.config.connectionId, expectedRevision: connection.revision, receiverRef: connection.receiver.ref }
  f.wire.state.endpointCode = 0
  expect(result(await f.rootCli(['connection', 'receiver', 'recover', '--input', '-', '--runtime', owner.runtimeId], JSON.stringify(input))).operation.disposition).toBe('scheduled')
  await f.ready()
  expect(result(await f.rootCli(['connection', 'receiver', 'inspect', '--operation-id', input.operationId, '--runtime', owner.runtimeId])).operation.operationId).toBe(input.operationId)
  const help = await f.rootCli(['runtime', 'owner', 'identity', '--help']), skill = await f.rootCli(['runtime', '--skill'])
  expect(help.code).toBe(0); expect(help.stdout).toContain('typed owner'); expect(skill.code).toBe(0); expect(skill.stdout).toContain('runtime owner identity')
  expect(f.wire.sockets).toHaveLength(1); f.unchanged()
})

it('healthy original receivers are administered through actual Hosted forwarding and compiled CLI without rotation', async () => {
  const f = await receiverRecoveryFixture(cleanup); await f.ready()
  const input = await f.target('healthy-original'), ref = input.receiverRef
  expect((await f.current()).capabilities?.receiverRecovery).toBe(true)
  expect(await f.recover(input)).toMatchObject({ operation: { operationId: input.operationId, receiverRef: ref, configurationRevision: 1, disposition: 'already-ready' }, connection: { receiver: { ref, state: 'ready' } } })
  const stdin = result(await f.cli(['receiver', 'recover', '--input', '-'], JSON.stringify({ ...input, operationId: 'cli-original' })))
  expect(stdin.operation.disposition).toBe('already-ready')
  const path = join(f.root, 'recover.json'); await writeFile(path, JSON.stringify({ ...input, operationId: 'file-original' }))
  expect(result(await f.cli(['receiver', 'recover', '--input', path])).operation.disposition).toBe('already-ready')
  expect(result(await f.cli(['receiver', 'inspect', '--operation-id', 'cli-original'])).operation).toEqual(stdin.operation)
  const before = f.wire.requests.length
  expect((await f.rpc.call('connection.receiver.inspect', { operationId: 'unknown-original' }, { runtimeFence: f.fence })).operation).toBeNull()
  expect(f.wire.requests).toHaveLength(before)
  const help = await f.cli(['receiver', 'recover', '--help']), skill = await f.cli(['--skill'])
  expect(help.code).toBe(0); expect(help.stdout).toContain('receiverRef'); expect(help.stdout).toContain('null only joins')
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('connection receiver recover --input'); expect(skill.stdout).toContain('connection receiver inspect --operation-id')
  expect(f.forwarded).toContain('connection.receiver.recover'); expect(f.forwarded).toContain('connection.receiver.inspect')
  const unresolved = await f.cliForwarded(['receiver', 'recover', '--input', '-'], JSON.stringify({ ...input, operationId: 'unresolved-route' }))
  expect(unresolved.code).not.toBe(0); expect(unresolved.stdout + unresolved.stderr).toContain('original connector hosting endpoint')
  const forwarded = f.forwarded.length
  f.identity.runtimeId = 'same-alias-replacement'
  const replaced = await f.cli(['receiver', 'recover', '--input', '-'], JSON.stringify({ ...input, operationId: 'cli-wrong-runtime' }))
  expect(replaced.code).not.toBe(0); expect(replaced.stdout + replaced.stderr).toContain('RUNTIME_OWNER_MISMATCH')
  expect(f.forwarded).toHaveLength(forwarded)
  f.identity.runtimeId = f.fence.runtimeId
  expect(f.wire.sockets).toHaveLength(1); f.unchanged()
})

it('same-revision platform requalification survives a lost reply and original journal inspection without replaying input', async () => {
  const f = await receiverRecoveryFixture(cleanup, { endpointCode: 514 })
  await waitReceiver(async () => expect((await f.current()).receiver).toMatchObject({ state: 'ended', reason: 'native-rejected' }))
  const input = await f.target('lost-reply-original'); f.wire.state.endpointCode = 0
  const original = f.owner.receiver!.recover.bind(f.owner.receiver)
  vi.spyOn(f.owner.receiver!, 'recover').mockImplementationOnce(async (value, context) => { const receipt = await original(value, context); await f.rpc.dispose(); return receipt })
  await expect(f.recover(input)).rejects.toBeDefined()
  await f.reconnect()
  const observed = result(await f.cli(['receiver', 'inspect', '--operation-id', input.operationId]))
  expect(observed.operation).toMatchObject({ operationId: input.operationId, receiverRef: input.receiverRef, configurationRevision: 1, disposition: 'scheduled' })
  await f.ready(); const current = (await f.current()).receiver!.ref
  expect(current).not.toBe(input.receiverRef)
  f.wire.message('recovered-original'); await waitReceiver(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const reads = f.wire.requests.length
  expect(result(await f.cli(['receiver', 'recover', '--input', '-'], JSON.stringify(input))).operation).toEqual(observed.operation)
  expect(f.wire.requests).toHaveLength(reads); expect(f.wire.sockets).toHaveLength(1)
  // The same Host database retains the action; its normal enabled startup may
  // create a current consumer, but repeating the old action cannot rotate it.
  await f.restart(); await f.ready(); const restarted = (await f.current()).receiver!.ref
  expect(restarted).not.toBe(current)
  expect(result(await f.cli(['receiver', 'inspect', '--operation-id', input.operationId])).operation).toEqual(observed.operation)
  result(await f.cli(['receiver', 'recover', '--input', '-'], JSON.stringify(input)))
  expect((await f.current()).receiver!.ref).toBe(restarted)
  f.wire.message('recovered-original'); await waitReceiver(() => expect(f.wire.acknowledgements).toHaveLength(2))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect((await f.services.ingress!.list({ connectionId: input.connectionId })).ingresses).toHaveLength(1)
  f.unchanged()
})

it('concurrent old-ref operations schedule one consumer and same-operation conflicts cannot retarget it', async () => {
  const f = await receiverRecoveryFixture(cleanup, { endpointCode: 403 })
  await waitReceiver(async () => expect((await f.current()).receiver?.state).toBe('ended'))
  const input = await f.target('concurrent-original'); f.wire.state.endpointCode = 0
  const replies = await Promise.all([input, { ...input, operationId: 'concurrent-second' }, input].map(value => f.recover(value)))
  expect(replies[0]!.operation.disposition).toBe('scheduled'); expect(replies[2]!.operation).toEqual(replies[0]!.operation)
  expect(replies[1]!.operation.disposition).toBe('not-current')
  await f.ready(); const current = (await f.current()).receiver!.ref
  expect((await f.recover({ ...input, operationId: 'late-original' })).operation.disposition).toBe('not-current')
  await expect(f.recover({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(f.recover({ ...input, receiverRef: current })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect(f.wire.requests.filter(r => r.url?.endsWith('/callback/ws/endpoint'))).toHaveLength(2)
  expect(f.wire.sockets).toHaveLength(1); expect((await f.current()).receiver!.ref).toBe(current); f.unchanged()
})

it('original journal inspection survives actual management-process death and a new owner instance', async () => {
  const f = await receiverRecoveryFixture(cleanup); await f.ready()
  const input = await f.target('process-original'), admitted = await f.recover(input)
  await f.services.close()
  const seenOwners: string[] = []
  for (let generation = 0; generation < 2; generation++) {
    const child = fork(new URL('./fixtures/receiver-journal-owner.mjs', import.meta.url), [join(f.root, 'receiver-host'), f.fence.runtimeId], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''; child.stderr!.on('data', data => { stderr += data })
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended } })
    const ready = await Promise.race([once(child, 'message').then(([value]) => value as { socketPath: string }), once(child, 'exit').then(() => { throw Error('Private journal process failed: ' + stderr) })])
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: ready.socketPath } }); cleanup.push(() => rpc.dispose())
    const { owner } = await rpc.call('runtime.owner.identity', {}), runtimeFence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
    const cli = (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', 'unix:' + ready.socketPath, ...args], objectCliEnvironment(f.root), stdin)
    const discovered = result(await cli(['runtime', 'owner', 'identity'])).owner
    expect(discovered.runtimeId).toBe(f.fence.runtimeId); seenOwners.push(discovered.ownerInstanceId)
    expect(result(await cli(['connection', 'receiver', 'inspect', '--operation-id', input.operationId, '--runtime', discovered.runtimeId])).operation).toEqual(admitted.operation)
    expect(result(await cli(['connection', 'receiver', 'recover', '--input', '-', '--runtime', discovered.runtimeId], JSON.stringify(input))).operation).toEqual(admitted.operation)
    expect((await rpc.call('connection.receiver.inspect', { operationId: input.operationId }, { runtimeFence })).operation).toEqual(admitted.operation)
    expect((await rpc.call('connection.receiver.recover', input, { runtimeFence })).operation).toEqual(admitted.operation)
    expect(f.wire.sockets).toHaveLength(1)
    const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; await rpc.dispose()
  }
  expect(new Set(seenOwners).size).toBe(2)
  f.unchanged()
})

it('an unconfirmed stored receipt cannot retarget its original frozen recovery input', async () => {
  const f = await receiverRecoveryFixture(cleanup); await f.ready()
  const input = await f.target('frozen-receipt'), saved = await f.recover(input), database = f.services.database!
  database.prepare('UPDATE connection_configuration_operation SET result_json=? WHERE operation_id=?').run(JSON.stringify({ ...saved.operation, connectionId: 'foreign-connection' }), input.operationId)
  const reads = f.wire.requests.length
  await expect(f.recover(input)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_DATA' })
  expect(f.wire.requests).toHaveLength(reads); expect(f.wire.sockets).toHaveLength(1)
  expect((await f.current()).receiver!.ref).toBe(input.receiverRef); f.unchanged()
})

it('a lost commit acknowledgement can only continue the durably admitted original ref once', async () => {
  const f = await receiverRecoveryFixture(cleanup, { endpointCode: 514 })
  await waitReceiver(async () => expect((await f.current()).receiver?.state).toBe('ended'))
  const input = await f.target('commit-original'); f.wire.state.endpointCode = 0
  const database = f.services.database!, exec = database.exec.bind(database); let lose = true
  const spy = vi.spyOn(database, 'exec').mockImplementation(sql => { exec(sql); if (sql === 'COMMIT' && lose) { lose = false; throw new Error('Controlled original commit acknowledgement loss') } })
  await expect(f.recover(input)).rejects.toMatchObject({ code: 'CONNECTION_STORAGE_UNCONFIRMED' })
  spy.mockRestore()
  expect(f.wire.sockets).toEqual([])
  expect((await f.rpc.call('connection.receiver.inspect', { operationId: input.operationId }, { runtimeFence: f.fence })).operation?.disposition).toBe('scheduled')
  expect((await f.recover(input)).operation.disposition).toBe('scheduled'); await f.ready()
  await f.recover(input); expect(f.wire.sockets).toHaveLength(1); f.unchanged()
})

it('explicit recovery joins the original native terminal spacing before Host continuation', async () => {
  const f = await receiverRecoveryFixture(cleanup); await f.ready()
  f.wire.nativeConfig.ReconnectInterval = 10
  f.wire.sockets[0]!.terminate()
  await waitReceiver(() => expect(f.wire.sockets).toHaveLength(2)); await f.ready()
  f.wire.state.nextEndpointCode = 1; f.wire.sockets[1]!.terminate()
  await waitReceiver(async () => expect((await f.current()).receiver).toMatchObject({ state: 'ended', reason: 'native-unavailable' }))
  const input = await f.target('native-spacing'), reads = f.wire.requests.length
  expect((await f.recover(input)).operation.disposition).toBe('joined')
  expect(f.wire.requests).toHaveLength(reads); expect((await f.current()).receiver!.ref).toBe(input.receiverRef)
  f.unchanged()
})

it('unexposed startup refs only join the original opening and never create a second HTTP/SDK start', async () => {
  let release!: () => void
  const botWait = new Promise<void>(resolve => { release = resolve }); cleanup.push(() => release())
  const f = await receiverRecoveryFixture(cleanup, { botWait })
  const input = await f.target('opening-original'); expect(input.receiverRef).toBeNull()
  const first = await f.recover(input)
  expect(first.operation.disposition).toBe('joined')
  expect((await f.recover(input)).operation).toEqual(first.operation)
  expect(f.wire.sockets).toEqual([])
  release(); await f.ready()
  await f.recover(input); expect(f.wire.sockets).toHaveLength(1)
  expect(f.wire.requests.filter(r => r.url?.endsWith('/bot/v3/info'))).toHaveLength(1); f.unchanged()
})

it('SDK retry is joined while unknown observation, revision, disabled policy and wrong authority retain healthy capability', async () => {
  let failObservation = false, release!: () => void, blocked: Promise<void> | undefined
  const f = await receiverRecoveryFixture(cleanup, { observationFails: () => failObservation, endpointWait: () => blocked }); await f.ready()
  const input = await f.target('observation-original')
  failObservation = true
  expect((await f.recover(input)).operation.disposition).toBe('unconfirmed'); expect(f.wire.sockets).toHaveLength(1)
  failObservation = false
  await expect(f.rpc.call('connection.receiver.recover', { ...input, operationId: 'wrong-runtime' }, { runtimeFence: { ...f.fence, runtimeId: 'foreign-runtime' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(f.rpc.call('connection.receiver.inspect', { operationId: input.operationId })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const agent = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.server.path }, credentials: f.credentials }); cleanup.push(() => agent.dispose())
  await expect(agent.call('connection.receiver.recover', { ...input, operationId: 'agent-denied' }, { runtimeFence: f.fence })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(agent.call('connection.receiver.inspect', { operationId: input.operationId }, { runtimeFence: f.fence })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  blocked = new Promise<void>(resolve => { release = resolve }); cleanup.push(() => release())
  f.wire.sockets[0]!.terminate()
  await waitReceiver(async () => expect((await f.current()).receiver?.state).toBe('recovering'))
  expect((await f.recover({ ...input, operationId: 'sdk-join' })).operation.disposition).toBe('joined')
  release(); blocked = undefined; await f.ready()
  expect((await f.current()).receiver!.ref).toBe(input.receiverRef)
  await f.owner.configure({ operationId: 'new-config', expectedRevision: 1, connection: { ...(await f.current()).config, label: 'Current label' } })
  expect((await f.recover({ ...input, operationId: 'old-revision' })).operation.disposition).toBe('not-current')
  await f.owner.service!.configure({ operationId: 'disable-original', expectedRevision: 0, service: { enabled: false } })
  expect((await f.recover({ ...input, operationId: 'disabled-original', expectedRevision: 2 })).operation.disposition).toBe('disabled')
  expect((await f.owner.service!.get({})).enabled).toBe(false); f.unchanged()
})
