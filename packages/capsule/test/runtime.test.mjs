import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintObjectId } from '@agentmux/identity'
import {
  capsuleRuntimeEntrypoint,
  connectCapsuleRuntime,
  startCapsuleRuntime,
  parseCapsuleRuntimeIdentity,
} from '../dist/runtime.js'
import { CAPSULE_RUNTIME_MAX_FRAME_BYTES, RuntimeChannel } from '../dist/runtime-wire.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const principal = { kind: 'user', id: 'confirmed-local-user' }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function until(read, accept, label) {
  const stop = Date.now() + 8000
  while (Date.now() < stop) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`Original observation did not reach ${label}.`)
}
async function fixture(t) {
  const directory = await mkdtemp('/tmp/amux-cap-runtime-')
  const sourcePath = join(directory, 'source')
  const stateDirectory = join(directory, 'state')
  const socketPath = join(directory, 'runtime.sock')
  await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'index.html'), '<h1>Independent serving process</h1>')
  const processes = new Set(),
    clients = new Set()
  t.after(async () => {
    for (const client of clients) await client.dispose()
    for (const process of processes) {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill('SIGKILL')
        await once(process, 'exit')
      }
    }
    await rm(directory, { recursive: true, force: true })
  })
  async function start() {
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-loader',
        join(root, 'test/runtime-no-core-loader.mjs'),
        capsuleRuntimeEntrypoint(),
        'serve',
        '--state-directory',
        stateDirectory,
        '--socket',
        socketPath,
      ],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    processes.add(child)
    let output = '',
      error = ''
    child.stderr.on('data', (chunk) => {
      error += chunk
    })
    const identity = await new Promise((accept, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (!output.includes('\n')) return
        try {
          const ready = JSON.parse(output.split('\n')[0])
          assert.equal(ready.event, 'capsule.runtime.ready')
          accept(parseCapsuleRuntimeIdentity(ready.identity))
        } catch (failure) {
          reject(failure)
        }
      })
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        reject(new Error(`Independent runtime exited ${code ?? signal}: ${error}`)),
      )
    })
    return { child, identity }
  }
  async function connect(adapters, expectedRuntimeId) {
    const client = await connectCapsuleRuntime({
      socketPath,
      ...(adapters ? { adapters } : {}),
      ...(expectedRuntimeId ? { expectedRuntimeId } : {}),
    })
    clients.add(client)
    return client
  }
  async function page(client, operationId = 'publish', extra = {}) {
    return client.call('capsule.create', { operationId, sourcePath, ...extra })
  }
  return { directory, sourcePath, stateDirectory, socketPath, start, connect, page }
}
function rendered(params, resolved, suffix = params.operationId) {
  return {
    operationId: params.operationId,
    capsuleId: params.capsuleId,
    endpoint: resolved.endpoint,
    rendering: {
      status: 'available',
      browserId: `browser-${suffix}`,
      tabId: `tab-${suffix}`,
      regionId: `region-${suffix}`,
    },
  }
}
function prepared(input, context) {
  return {
    version: 1,
    operationId: input.operationId,
    capsuleId: input.interaction.capsuleId,
    interactionId: input.interaction.interactionId,
    inputOperationId: input.inputOperationId,
    target: input.interaction.target,
    expectedRun: { runId: 'original-run' },
    principal: context.principal,
    prompt: input.answer,
    adapterData: { sourceChannel: 'question-reply' },
  }
}
function inputObservation(input) {
  return {
    status: 'submitted',
    inputOperationId: input.inputOperationId,
    expectedRun: input.expectedRun,
    inputStatus: 'admitted',
    receipt: { originalInput: input.inputOperationId },
  }
}

test('independent fixed entry serves without Core and client disposal never stops HTTP', async (t) => {
  const f = await fixture(t)
  assert.ok(capsuleRuntimeEntrypoint().endsWith('/dist/runtime-cli.js'))
  const service = await f.start()
  assert.notEqual(service.identity.pid, process.pid)
  assert.equal((await stat(f.socketPath)).mode & 0o777, 0o600)
  const client = await f.connect()
  assert.deepEqual(await client.identity(), service.identity)
  const page = await f.page(client)
  const url = page.endpoint.url
  const pathPage = await f.page(client, 'path-page', { storageMode: 'path', mode: 'injected' })
  await writeFile(join(f.sourcePath, 'index.html'), '<h1>Live external path</h1>')
  assert.match(await (await fetch(url)).text(), /Independent serving process/u)
  assert.match(await (await fetch(pathPage.endpoint.url)).text(), /Live external path/u)
  assert.equal(
    (await fetch(url)).headers.get('X-AgentMux-Capsule-Instance'),
    page.endpoint.instanceId,
  )
  const open = await client.call('capsule.open', {
    capsuleId: page.record.capsuleId,
    operationId: 'headless-open',
  })
  assert.equal(open.rendering.status, 'unavailable')
  await assert.rejects(
    startCapsuleRuntime({
      stateDirectory: f.stateDirectory,
      socketPath: join(f.directory, 'second.sock'),
    }),
    { code: 'CAPSULE_OWNER_BUSY' },
  )
  await assert.rejects(
    startCapsuleRuntime({
      stateDirectory: join(f.directory, 'other-state'),
      socketPath: f.socketPath,
    }),
    { code: 'CAPSULE_RUNTIME_SOCKET_BUSY' },
  )
  const request = await client.call('capsule.interaction.request', {
    capsuleId: page.record.capsuleId,
    operationId: 'question',
    question: 'Keep this page?',
    draft: 'retained',
  })
  await client.dispose()
  await assert.rejects(client.identity(), { code: 'CAPSULE_OPERATION_UNKNOWN' })
  assert.match(await (await fetch(url)).text(), /Independent serving process/u)
  const reconnected = await f.connect(undefined, service.identity.runtimeId)
  assert.deepEqual(await reconnected.identity(), service.identity)
  assert.equal(
    (
      await reconnected.call('capsule.interaction.inspect', {
        capsuleId: page.record.capsuleId,
        interactionId: request.interaction.interactionId,
      })
    ).interaction.draft,
    'retained',
  )
  await assert.rejects(f.connect(undefined, mintObjectId()), {
    code: 'CAPSULE_RUNTIME_IDENTITY_MISMATCH',
  })
  assert.equal(
    (await reconnected.call('capsule.resolve', { capsuleId: page.record.capsuleId })).endpoint.url,
    url,
  )
})

test('process death keeps domain page origin and operations with a fresh owner instance', async (t) => {
  const f = await fixture(t)
  const first = await f.start(),
    client = await f.connect()
  const page = await f.page(client)
  const original = {
    runtimeId: first.identity.runtimeId,
    capsuleId: page.record.capsuleId,
    port: page.record.port,
    instanceId: page.endpoint.instanceId,
    url: page.endpoint.url,
  }
  first.child.kill('SIGKILL')
  await once(first.child, 'exit')
  await assert.rejects(client.identity(), { code: 'CAPSULE_OPERATION_UNKNOWN' })
  const second = await f.start(),
    next = await f.connect(undefined, original.runtimeId)
  assert.equal(second.identity.runtimeId, original.runtimeId)
  assert.notEqual(second.identity.ownerInstanceId, first.identity.ownerInstanceId)
  assert.notEqual(second.identity.pid, first.identity.pid)
  const restored = await next.call('capsule.inspect', { capsuleId: original.capsuleId })
  assert.equal(restored.record.port, original.port)
  assert.equal(restored.endpoint.url, original.url)
  assert.notEqual(restored.endpoint.instanceId, original.instanceId)
  assert.equal(
    (await next.call('capsule.operation.inspect', { operationId: 'publish' })).operation.status,
    'committed',
  )
  assert.match(await (await fetch(original.url)).text(), /Independent serving process/u)
  second.child.kill('SIGTERM')
  const [code, signal] = await once(second.child, 'exit')
  assert.equal(code, 0)
  assert.equal(signal, null)
})

test('concurrent sockets and calls return only their original scoped callback and context', async (t) => {
  const f = await fixture(t)
  await f.start()
  const reached = deferred(),
    release = deferred(),
    visits = []
  let clientA
  const makeAdapters = (clientName) => ({
    presentation: {
      async open(params, context, resolved) {
        visits.push({ clientName, params, context })
        assert.equal(context.caller.agentSessionId, params.operationId)
        if (params.operationId === 'open-a') {
          const pending = await clientA.call('capsule.operation.inspect', {
            operationId: params.operationId,
          })
          assert.equal(pending.operation.status, 'pending')
          reached.resolve()
          await release.promise
        }
        return rendered(params, resolved, `${clientName}-${params.operationId}`)
      },
    },
  })
  clientA = await f.connect(makeAdapters('a'))
  const clientB = await f.connect(makeAdapters('b'))
  const first = await f.page(clientA, 'page-a'),
    second = await f.page(clientB, 'page-b')
  const pending = clientA.call(
    'capsule.open',
    { capsuleId: first.record.capsuleId, operationId: 'open-a' },
    { caller: { hostId: 'serving-host', agentSessionId: 'open-a' }, principal },
  )
  await reached.promise
  const other = await clientB.call(
    'capsule.open',
    { capsuleId: second.record.capsuleId, operationId: 'open-b' },
    {
      caller: { hostId: 'other-host', agentSessionId: 'open-b' },
      principal: { kind: 'device', id: 'other-device' },
    },
  )
  assert.equal(other.rendering.browserId, 'browser-b-open-b')
  const sameSocket = await clientA.call(
    'capsule.open',
    { capsuleId: second.record.capsuleId, operationId: 'open-c' },
    { caller: { hostId: 'serving-host', agentSessionId: 'open-c' }, principal },
  )
  assert.equal(sameSocket.rendering.browserId, 'browser-a-open-c')
  release.resolve()
  assert.equal((await pending).rendering.browserId, 'browser-a-open-a')
  assert.deepEqual(
    visits.map(({ clientName, params }) => `${clientName}:${params.operationId}`),
    ['a:open-a', 'b:open-b', 'a:open-c'],
  )
})

test('disconnect preserves unknown original open and reconnection only inspects without replay', async (t) => {
  const f = await fixture(t)
  await f.start()
  const reached = deferred()
  let originalReceipt,
    opens = 0,
    inspections = 0
  const first = await f.connect({
    presentation: {
      async open(params, context, resolved) {
        opens++
        originalReceipt = rendered(params, resolved)
        reached.resolve()
        await new Promise((resolve) =>
          context.signal.addEventListener('abort', resolve, { once: true }),
        )
        return originalReceipt
      },
    },
  })
  const page = await f.page(first)
  const params = { capsuleId: page.record.capsuleId, operationId: 'original-open' }
  const pending = first.call('capsule.open', params)
  const failed = assert.rejects(pending, { code: 'CAPSULE_OPERATION_UNKNOWN' })
  await reached.promise
  await first.dispose()
  await failed
  assert.equal((await fetch(page.endpoint.url)).status, 200)
  const next = await f.connect({
    presentation: {
      async open() {
        opens++
        throw new Error('A replacement open must never execute.')
      },
      async inspect(input) {
        inspections++
        assert.deepEqual(input, params)
        return originalReceipt
      },
    },
  })
  const saved = await until(
    () => next.call('capsule.operation.inspect', { operationId: params.operationId }),
    (result) => result.operation?.status === 'committed',
    'the original rendering receipt',
  )
  assert.deepEqual(saved.operation.result, originalReceipt)
  assert.deepEqual(await next.call('capsule.open', params), originalReceipt)
  assert.equal(opens, 1)
  assert.equal(inspections, 1)
})

test('per-call cancellation reaches the original adapter and preserves unrelated calls', async (t) => {
  const f = await fixture(t)
  await f.start()
  const reached = deferred(),
    aborted = deferred()
  const client = await f.connect({
    presentation: {
      async open(params, context, resolved) {
        reached.resolve()
        await new Promise((resolve) =>
          context.signal.addEventListener(
            'abort',
            () => {
              aborted.resolve()
              resolve()
            },
            { once: true },
          ),
        )
        return rendered(params, resolved)
      },
    },
  })
  const page = await f.page(client)
  const controller = new AbortController()
  const pending = client.call(
    'capsule.open',
    { capsuleId: page.record.capsuleId, operationId: 'cancelled-open' },
    { signal: controller.signal },
  )
  const failed = assert.rejects(pending, { code: 'CAPSULE_OPERATION_UNKNOWN' })
  await reached.promise
  controller.abort()
  await failed
  await aborted.promise
  const operation = await until(
    () => client.call('capsule.operation.inspect', { operationId: 'cancelled-open' }),
    (result) => result.operation?.issue,
    'the original unknown observation',
  )
  assert.equal(operation.operation.status, 'pending')
  assert.equal(
    (await client.call('capsule.resolve', { capsuleId: page.record.capsuleId })).endpoint.status,
    'available',
  )
  const before = new AbortController()
  before.abort()
  await assert.rejects(
    client.call(
      'capsule.create',
      { operationId: 'not-sent', sourcePath: f.sourcePath },
      { signal: before.signal },
    ),
    { code: 'CAPSULE_CALL_CANCELLED' },
  )
  assert.equal(
    (await client.call('capsule.operation.inspect', { operationId: 'not-sent' })).operation,
    null,
  )
})

test('trusted reply callbacks preserve input identity and disconnect never repeats submission', async (t) => {
  const f = await fixture(t)
  await f.start()
  const reached = deferred()
  let reserved,
    submitted = 0,
    inspected = 0
  const client = await f.connect({
    replies: {
      async prepare(input, context) {
        assert.deepEqual(context.principal, principal)
        const original = (
          await client.call('capsule.operation.inspect', { operationId: input.operationId })
        ).operation
        assert.equal(original.inputOperationId, input.inputOperationId)
        reserved = prepared(input, context)
        return reserved
      },
      async submit(input, context) {
        submitted++
        assert.deepEqual(input, reserved)
        reached.resolve()
        await new Promise((resolve) =>
          context.signal.addEventListener('abort', resolve, { once: true }),
        )
        return inputObservation(input)
      },
      async inspect() {
        throw new Error('Original client is disconnected before observation.')
      },
    },
  })
  const page = await f.page(client, 'targeted-page', {
    target: { hostId: 'target-host', agentSessionId: 'original-agent' },
  })
  const interaction = (
    await client.call('capsule.interaction.request', {
      capsuleId: page.record.capsuleId,
      operationId: 'request',
      question: 'Accept?',
    })
  ).interaction
  const params = {
    capsuleId: page.record.capsuleId,
    interactionId: interaction.interactionId,
    operationId: 'original-reply',
    expectedRevision: interaction.revision,
    answer: 'The exact human answer.',
  }
  const attempt = client.call('capsule.interaction.reply', params, { principal })
  const failed = assert.rejects(attempt, { code: 'CAPSULE_OPERATION_UNKNOWN' })
  await reached.promise
  await client.dispose()
  await failed
  const next = await f.connect({
    replies: {
      async prepare() {
        throw new Error('Unknown reply cannot prepare a replacement.')
      },
      async submit() {
        submitted++
        throw new Error('Unknown reply cannot submit again.')
      },
      async inspect(input) {
        inspected++
        assert.deepEqual(input, reserved)
        return inputObservation(input)
      },
    },
  })
  const recovered = await until(
    () =>
      next.call('capsule.interaction.inspect', {
        capsuleId: params.capsuleId,
        interactionId: params.interactionId,
      }),
    (result) => result.interaction.reply?.delivery.status === 'submitted',
    'original interaction input observation',
  )
  assert.equal(recovered.interaction.reply.delivery.inputOperationId, reserved.inputOperationId)
  const observed = await until(
    () => next.call('capsule.operation.inspect', { operationId: params.operationId }),
    (result) => result.operation?.status === 'committed',
    'original Core input observation',
  )
  assert.equal(observed.operation.inputOperationId, reserved.inputOperationId)
  assert.equal(observed.operation.result.delivery.inputOperationId, reserved.inputOperationId)
  assert.equal(submitted, 1)
  assert.equal(inspected, 2)
  const headless = await f.connect()
  await assert.rejects(
    headless.call(
      'capsule.interaction.reply',
      { ...params, operationId: 'forged-human' },
      { principal },
    ),
    { code: 'CAPSULE_TRUSTED_REPLY_UNAVAILABLE' },
  )
  assert.equal(
    (await headless.call('capsule.operation.inspect', { operationId: 'forged-human' })).operation,
    null,
  )
})

test('wire rejects malformed and oversized frames without harming other clients or reserving effects', async (t) => {
  const f = await fixture(t)
  await f.start()
  const healthy = await f.connect()
  const page = await f.page(healthy)
  const malformed = createConnection(f.socketPath)
  await once(malformed, 'connect')
  const closed = once(malformed, 'close')
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'call',
      id: mintObjectId(),
      method: 'capsule.create',
      params: { operationId: 'malformed', sourcePath: f.sourcePath, authorHuman: true },
    }),
  )
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  // Split header and UTF-8 payload must still reach the same strict parser.
  malformed.write(header.subarray(0, 2))
  malformed.write(Buffer.concat([header.subarray(2), body]))
  await closed
  const oversized = createConnection(f.socketPath)
  await once(oversized, 'connect')
  const overClosed = once(oversized, 'close')
  const overHeader = Buffer.alloc(4)
  overHeader.writeUInt32BE(CAPSULE_RUNTIME_MAX_FRAME_BYTES + 1)
  oversized.write(overHeader)
  await overClosed
  assert.equal(
    (await healthy.call('capsule.operation.inspect', { operationId: 'malformed' })).operation,
    null,
  )
  await assert.rejects(
    healthy.call('capsule.interaction.request', {
      capsuleId: page.record.capsuleId,
      operationId: 'too-large',
      question: 'large',
      draft: 'x'.repeat(CAPSULE_RUNTIME_MAX_FRAME_BYTES),
    }),
    { code: 'CAPSULE_RUNTIME_FRAME_TOO_LARGE' },
  )
  assert.equal(
    (await healthy.call('capsule.operation.inspect', { operationId: 'too-large' })).operation,
    null,
  )
  const normal = await healthy.call('capsule.interaction.request', {
    capsuleId: page.record.capsuleId,
    operationId: 'valid-long-draft',
    question: 'normal',
    draft: 'x'.repeat(300000),
  })
  assert.equal(normal.interaction.draft.length, 300000)
  assert.equal((await fetch(page.endpoint.url)).status, 200)
})

test('callback wire cannot redirect original client authority to a different pending operation', async (t) => {
  const f = await fixture(t)
  const server = createServer()
  server.listen(f.socketPath)
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  let adapterCalls = 0
  const identity = {
    runtimeId: mintObjectId(),
    ownerInstanceId: mintObjectId(),
    pid: process.pid,
    stateDirectory: f.stateDirectory,
  }
  server.on('connection', (socket) => {
    const channel = new RuntimeChannel(
      socket,
      (request) => {
        if (request.kind === 'hello')
          channel.send({ version: 1, kind: 'result', id: request.id, ok: true, value: identity })
        else if (request.kind === 'call')
          channel.send({
            version: 1,
            kind: 'callback',
            id: mintObjectId(),
            callId: request.id,
            method: 'presentation.inspect',
            input: { params: { capsuleId: mintObjectId(), operationId: 'foreign-operation' } },
          })
        else if (request.kind === 'callback.result')
          channel.send({
            version: 1,
            kind: 'result',
            id: request.callId,
            ok: true,
            value: { operation: null },
          })
      },
      () => socket.destroy(),
    )
  })
  const client = await f.connect({
    presentation: {
      async open() {
        adapterCalls++
        throw new Error('Wrong call')
      },
      async inspect() {
        adapterCalls++
        return null
      },
    },
  })
  await assert.rejects(
    client.call('capsule.operation.inspect', { operationId: 'original-operation' }),
    { code: 'CAPSULE_RUNTIME_PROTOCOL_INVALID' },
  )
  assert.equal(adapterCalls, 0)
})

test('callback results from another socket cannot complete or replace the original operation', async (t) => {
  const f = await fixture(t)
  await f.start()
  const healthy = await f.connect(),
    page = await f.page(healthy)
  const originalSocket = createConnection(f.socketPath)
  await once(originalSocket, 'connect')
  t.after(() => originalSocket.destroy())
  const hello = deferred(),
    callback = deferred(),
    completed = deferred()
  const helloId = mintObjectId(),
    callId = mintObjectId()
  const original = new RuntimeChannel(
    originalSocket,
    (message) => {
      if (message.kind === 'callback') callback.resolve(message)
      else if (message.id === helloId) hello.resolve(message)
      else completed.resolve(message)
    },
    (error) => {
      completed.reject(error)
      originalSocket.destroy()
    },
  )
  original.send({ version: 1, kind: 'hello', id: helloId, callbacks: ['presentation.open'] })
  assert.equal((await hello.promise).ok, true)
  const params = { capsuleId: page.record.capsuleId, operationId: 'exact-socket-open' }
  original.send({ version: 1, kind: 'call', id: callId, method: 'capsule.open', params })
  const pending = await callback.promise
  const receipt = rendered(params, pending.input.resolved)
  const foreign = createConnection(f.socketPath)
  await once(foreign, 'connect')
  const closed = once(foreign, 'close')
  const foreignChannel = new RuntimeChannel(
    foreign,
    () => {},
    () => foreign.destroy(),
  )
  foreignChannel.send({
    version: 1,
    kind: 'callback.result',
    id: pending.id,
    callId,
    ok: true,
    value: { ...receipt, rendering: { ...receipt.rendering, browserId: 'foreign-browser' } },
  })
  await closed
  assert.equal(
    (await healthy.call('capsule.operation.inspect', { operationId: params.operationId })).operation
      .status,
    'pending',
  )
  original.send({
    version: 1,
    kind: 'callback.result',
    id: pending.id,
    callId,
    ok: true,
    value: receipt,
  })
  const result = await completed.promise
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, receipt)
  assert.equal((await fetch(page.endpoint.url)).status, 200)
})

test('runtime identity corruption and occupied socket never create a replacement domain', async (t) => {
  const f = await fixture(t)
  await mkdir(f.stateDirectory)
  await writeFile(
    join(f.stateDirectory, 'runtime.json'),
    '{"schemaVersion":1,"runtimeId":"corrupt"}\n',
  )
  await assert.rejects(
    startCapsuleRuntime({ stateDirectory: f.stateDirectory, socketPath: f.socketPath }),
    { code: 'CAPSULE_RUNTIME_IDENTITY_UNCONFIRMED' },
  )
  assert.equal(
    await readFile(join(f.stateDirectory, 'runtime.json'), 'utf8'),
    '{"schemaVersion":1,"runtimeId":"corrupt"}\n',
  )
  await writeFile(f.socketPath, 'original unrelated data')
  await assert.rejects(
    startCapsuleRuntime({ stateDirectory: f.stateDirectory, socketPath: f.socketPath }),
    { code: 'CAPSULE_RUNTIME_SOCKET_UNSAFE' },
  )
  assert.equal(await readFile(f.socketPath, 'utf8'), 'original unrelated data')
  await assert.rejects(
    startCapsuleRuntime({ stateDirectory: 'relative', socketPath: f.socketPath }),
    { code: 'invalid-params' },
  )
  await rm(f.socketPath)
  await chmod(f.directory, 0o755)
  await assert.rejects(
    startCapsuleRuntime({ stateDirectory: f.stateDirectory, socketPath: f.socketPath }),
    { code: 'CAPSULE_RUNTIME_SOCKET_UNSAFE' },
  )
  await chmod(f.directory, 0o700)
})

test('connection signal cancels unresponsive handshake and later identity without stopping the listener', async (t) => {
  const f = await fixture(t)
  const server = createServer(),
    sockets = new Set()
  server.listen(f.socketPath)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const helloSeen = deferred(),
    identitySeen = deferred()
  let connectionCount = 0
  const identity = {
    runtimeId: mintObjectId(),
    ownerInstanceId: mintObjectId(),
    pid: process.pid,
    stateDirectory: f.stateDirectory,
  }
  server.on('connection', (socket) => {
    sockets.add(socket)
    const count = ++connectionCount
    const channel = new RuntimeChannel(
      socket,
      (request) => {
        if (request.kind === 'hello') {
          if (count === 1) helloSeen.resolve()
          else
            channel.send({ version: 1, kind: 'result', id: request.id, ok: true, value: identity })
        } else if (request.kind === 'identity') identitySeen.resolve()
      },
      () => socket.destroy(),
    )
  })
  const handshakeController = new AbortController()
  const pending = connectCapsuleRuntime({
    socketPath: f.socketPath,
    signal: handshakeController.signal,
  })
  const cancelled = assert.rejects(pending, { code: 'CAPSULE_OPERATION_UNKNOWN' })
  await helloSeen.promise
  handshakeController.abort()
  await cancelled
  assert.equal(server.listening, true)
  const observationController = new AbortController()
  const connected = await connectCapsuleRuntime({
    socketPath: f.socketPath,
    signal: observationController.signal,
  })
  const stalled = connected.identity()
  const observationCancelled = assert.rejects(stalled, { code: 'CAPSULE_OPERATION_UNKNOWN' })
  await identitySeen.promise
  observationController.abort()
  await observationCancelled
  assert.equal(server.listening, true)
  await connected.dispose()
})
