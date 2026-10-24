import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const native = await import(process.env.NATIVE_TEST_ENTRY ?? '@agentmux/native-desktop')
const { NativeConnection, NativeDesktop, capturePageImage, pngBytes, pngFromBytes } = native
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')

async function fixture(run, handler = () => ({})) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-native-test-'))
  const socketPath = join(directory, 'native.sock')
  const calls = []
  const sockets = new Set()
  const instanceId = 'instance-original'
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8')
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        calls.push(request)
        const send = (result, overrides = {}) => socket.write(JSON.stringify({ id: request.id, ok: true, instanceId,
          ...(request.operationId ? { operationId: request.operationId } : {}), result, ...overrides }) + '\n')
        if (request.token !== 'exact-token') { send(undefined, { ok: false, error: { code: 'unauthorized', message: 'wrong token' } }); continue }
        if (request.method === 'handshake') send({ provider: 'agentmux-native-macos', protocolVersion: 1, instanceId })
        else Promise.resolve(handler(request, send, socket)).then(result => { if (result !== undefined) send(result) }).catch(() => socket.destroy())
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  await chmod(socketPath, 0o600)
  let connection
  try {
    connection = await NativeConnection.connect({ socketPath, token: 'exact-token', requestTimeoutMs: 1000 })
    await run({ connection, calls, socketPath, instanceId })
  } finally {
    connection?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

test('real Unix socket authenticates and correlates concurrent query results', async () => {
  await fixture(async ({ connection, calls, socketPath }) => {
    const result = await Promise.all([connection.request('listApps', {}), connection.request('permissionStatus', {})])
    assert.deepEqual(result, [{ method: 'listApps' }, { method: 'permissionStatus' }])
    assert.equal(calls.length, 3)
    assert.equal(calls[1].expectedInstanceId, 'instance-original')
    await assert.rejects(NativeConnection.connect({ socketPath, token: 'wrong-token' }), { code: 'unauthorized' })
    await chmod(socketPath, 0o666)
    await assert.rejects(NativeConnection.connect({ socketPath, token: 'exact-token' }), { code: 'unsafe_socket' })
  }, request => ({ method: request.method }))
})

test('lost mutation retains original operation and never replays', async () => {
  await fixture(async ({ connection, calls }) => {
    await assert.rejects(connection.request('typeText', { text: '  原文\n' }, { operationId: 'original-op' }), error => {
      assert.equal(error.code, 'operation_unknown')
      assert.deepEqual(error.operation, { operationId: 'original-op', requestId: 2, instanceId: 'instance-original', method: 'typeText', state: 'unknown' })
      return true
    })
    assert.equal(connection.inspectOperation('original-op').state, 'unknown')
    await assert.rejects(connection.request('typeText', { text: '  原文\n' }, { operationId: 'original-op' }))
    assert.equal(calls.filter(call => call.method === 'typeText').length, 1)
  }, (_request, _send, socket) => { socket.destroy() })
})

test('mutation timeout preserves late result without duplicate input', async () => {
  await fixture(async ({ connection, calls }) => {
    await assert.rejects(connection.request('clipboardWrite', { format: 'text', data: ' \n' }, { operationId: 'late-op', timeoutMs: 15 }), { code: 'operation_unknown' })
    assert.equal(connection.inspectOperation('late-op').state, 'unknown')
    await new Promise(resolve => setTimeout(resolve, 90))
    assert.equal(connection.inspectOperation('late-op').state, 'completed')
    assert.equal(connection.inspectOperation('late-op').resultAvailability, 'retained')
    assert.deepEqual(connection.inspectOperation('late-op').result, { written: true })
    await assert.rejects(connection.request('clipboardWrite', { format: 'text', data: ' \n' }, { operationId: 'late-op' }), { code: 'duplicate_operation' })
    assert.equal(calls.filter(call => call.operationId === 'late-op').length, 1)
    assert.equal(calls[1].params.data, ' \n')
  }, (_request, send) => { setTimeout(() => send({ written: true }), 45) })
})

test('wrong instance request is rejected before sending', async () => {
  await fixture(async ({ connection, calls }) => {
    await assert.rejects(connection.request('click', {}, { expectedInstanceId: 'replacement-instance' }), { code: 'instance_mismatch' })
    assert.equal(calls.length, 1)
  })
})

test('spoofed response instance cannot confirm an action', async () => {
  await fixture(async ({ connection }) => {
    await assert.rejects(connection.request('click', {}, { operationId: 'spoof-op' }), { code: 'operation_unknown' })
    assert.equal(connection.inspectOperation('spoof-op').state, 'unknown')
  }, (_request, send) => { send({ action: 'sent' }, { instanceId: 'wrong-instance' }) })
})

test('wrong operation receipt cannot confirm another action', async () => {
  await fixture(async ({ connection }) => {
    await assert.rejects(connection.request('click', {}, { operationId: 'exact-op' }), { code: 'operation_unknown' })
  }, (_request, send) => { send({ action: 'sent' }, { operationId: 'other-op' }) })
})

test('old-instance operation inspection never launches replacement', () => {
  const desktop = new NativeDesktop({ appPath: '/nonexistent/AgentMux Native.app' })
  assert.deepEqual(desktop.inspectOperation('original-op', 'dead-instance'), {
    operationId: 'original-op', instanceId: 'dead-instance', state: 'unknown', reason: 'original_receipt_unavailable'
  })
})

test('host owner refuses duplicate operation after native reconnect', async () => {
  await fixture(async ({ connection, calls }) => {
    const desktop = new NativeDesktop({})
    desktop.launch = async () => connection
    await desktop.request('clipboardWrite', { format: 'text', data: 'original' }, { operationId: 'owner-op' })
    // Replace the connection with another protocol fixture while retaining the host owner.
    await fixture(async ({ connection: replacement }) => {
      desktop.connection = replacement
      await assert.rejects(desktop.request('clipboardWrite', { format: 'text', data: 'original' }, { operationId: 'owner-op' }), { code: 'duplicate_operation' })
    })
    assert.equal(calls.filter(call => call.method === 'clipboardWrite').length, 1)
    await desktop.dispose()
  })
})

test('dispose during launch prevents original action submission', async () => {
  await fixture(async ({ connection, calls }) => {
    const desktop = new NativeDesktop({})
    let completeLaunch
    desktop.launch = () => new Promise(resolve => { completeLaunch = resolve })
    const request = desktop.request('click', {}, { operationId: 'disposed-op' })
    const rejected = assert.rejects(request, { code: 'unavailable' })
    const disposed = desktop.dispose()
    completeLaunch(connection)
    await Promise.all([rejected, disposed])
    assert.equal(calls.length, 1)
  })
})

test('late capture keeps its typed result on the original operation', async () => {
  await fixture(async ({ connection }) => {
    await assert.rejects(connection.request('captureScreenshot', { mode: 'selection' }, { operationId: 'capture-op', timeoutMs: 10 }), { code: 'operation_unknown' })
    await new Promise(resolve => setTimeout(resolve, 90))
    const receipt = connection.inspectOperation('capture-op')
    assert.equal(receipt.result.state, 'captured')
    assert.equal(receipt.result.screenshot.data, PNG.toString('base64'))
  }, (_request, send) => { setTimeout(() => send({ state: 'captured', screenshot: { data: PNG.toString('base64'), width: 1, height: 1, scale: 1 } }), 40) })
})

test('callers cannot rewrite the retained original business receipt', async () => {
  await fixture(async ({ connection }) => {
    const result = await connection.request('click', {}, { operationId: 'immutable-op' })
    assert.throws(() => { result.action.verification.state = 'verified' }, TypeError)
    const inspected = connection.inspectOperation('immutable-op')
    inspected.result.action.verification.state = 'verified'
    assert.equal(connection.inspectOperation('immutable-op').result.action.verification.state, 'unverified')
  }, () => ({ action: { verification: { state: 'unverified' } } }))
})

test('native convenience methods preserve clipboard text and typed cancellation', async () => {
  await fixture(async ({ connection, calls }) => {
    const desktop = new NativeDesktop({})
    desktop.launch = async () => connection
    assert.equal(await desktop.readClipboardText(), ' \n原文\n ')
    await desktop.writeClipboardText(' \n原文\n ')
    assert.equal(calls.at(-1).params.data, ' \n原文\n ')
    assert.deepEqual(await desktop.captureScreenshot(), { state: 'cancelled' })
    await desktop.dispose()
  }, request => request.method === 'clipboardRead' ? { data: ' \n原文\n ' } : request.method === 'captureScreenshot' ? { state: 'cancelled' } : { written: true })
})

test('invalid capture receipt does not become a cancellation', async () => {
  await fixture(async ({ connection }) => {
    const desktop = new NativeDesktop({})
    desktop.launch = async () => connection
    await assert.rejects(desktop.captureScreenshot(), { code: 'invalid_capture_result' })
    await desktop.dispose()
  }, () => ({ state: 'failed' }))
})

test('capture outcome is a machine string, not string-coerced display data', async () => {
  await fixture(async ({ connection }) => {
    const desktop = new NativeDesktop({})
    desktop.launch = async () => connection
    await assert.rejects(desktop.captureScreenshot(), { code: 'invalid_capture_result' })
    await desktop.dispose()
  }, () => ({ state: ['cancelled'] }))
})

test('fragmented UTF8 frames and coalesced responses preserve request boundaries', async () => {
  await fixture(async ({ connection }) => {
    assert.deepEqual(await connection.request('listApps', {}), { name: '原文' })
  }, (request, _send, socket) => {
    const response = Buffer.from(JSON.stringify({ id: request.id, ok: true, instanceId: 'instance-original', result: { name: '原文' } }) + '\n')
    const split = response.indexOf(Buffer.from('原')) + 1
    socket.write(response.subarray(0, split))
    setImmediate(() => socket.write(response.subarray(split)))
  })
})

test('page image port uses exact supplied pixels without starting native', async () => {
  let calls = 0
  const image = await capturePageImage({ capture: async () => { calls++; return { png: PNG, width: 1, height: 1 } } })
  assert.equal(calls, 1)
  assert.deepEqual(pngBytes(image), PNG)
  assert.equal(image.width, 1)
  await assert.rejects(capturePageImage({ capture: async () => ({ png: PNG, width: 2 }) }), /dimensions/)
})

test('PNG limits and metadata preserve original image boundary', () => {
  assert.throws(() => pngFromBytes(Buffer.from('not png')), /PNG/)
  const huge = Buffer.from(PNG)
  huge.writeUInt32BE(16385, 16)
  assert.throws(() => pngFromBytes(huge), /dimensions/)
  const image = pngFromBytes(PNG)
  assert.throws(() => pngBytes({ ...image, width: 2 }), /dimensions/)
  assert.throws(() => pngBytes({ ...image, byteLength: 2 }), /length/)
  assert.throws(() => pngBytes({ ...image, dataUrl: image.dataUrl + '!' }), /base64/)
})
