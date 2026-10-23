import { createServer, createConnection, type Socket } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { connectAgentMuxRpc, isAgentMuxRpcReplyUnconfirmed } from '../../../packages/core/src/public-rpc-client.js'
import { encodeHostedValue } from '../../../packages/core/src/hosted-value.js'
import type { AgentMuxHostedInvocation } from '../../../packages/core/src/hosted-client-contract.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = [], pids: number[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  for (const pid of pids.splice(0)) try { expect(() => process.kill(pid, 0)).toThrow() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private trusted-call resources did not all release.')
})
afterAll(async () => {
  if (process.env.AGENTMUX_TRUSTED_CALL_RECEIPT) await writeFile(process.env.AGENTMUX_TRUSTED_CALL_RECEIPT,
    JSON.stringify({ schema: 'agentmux.trusted-call-native-proof.v1', private: true, userRunsTouched: false,
      boundary: 'Production Headless CLI and actual Node Hosted/public RPC client, official private ctxmuxd and raw PTY. The Unix proxy drops one already-successful reply; it never replays requests. This is local transport evidence, not a phone, remote network or vendor/model proof.', facts }, null, 2) + '\n')
})

type Frame = { id?: string | number; method?: string; params?: { invocation?: { method: string; args: unknown[] } }; result?: unknown; error?: unknown }

/** Fault injection is confined to public JSON-RPC transport, outside the Core writer. */
async function lostReplyProxy(socketPath: string, ownerPath: string, operationId: string) {
  const sockets = new Set<Socket>(), requests: Frame[] = [], dropped: Frame[] = [], errors: Error[] = []
  const server = createServer(downstream => {
    const upstream = createConnection(ownerPath)
    for (const socket of [downstream, upstream]) {
      socket.setEncoding('utf8')
      sockets.add(socket); socket.once('close', () => sockets.delete(socket))
      socket.on('error', error => { errors.push(error); downstream.destroy(); upstream.destroy() })
    }
    let pendingRequest = '', pendingReply = '', selectedId: string | number | undefined
    downstream.on('data', bytes => {
      pendingRequest += bytes.toString('utf8')
      let end: number
      while ((end = pendingRequest.indexOf('\n')) >= 0) {
        const line = pendingRequest.slice(0, end); pendingRequest = pendingRequest.slice(end + 1)
        const request = JSON.parse(line) as Frame
        if (request.method === 'runtime.invoke') {
          requests.push(request)
          const invocation = request.params!.invocation!
          if (invocation.method === 'writeTerminal' && (invocation.args[1] as { operationId?: string }).operationId === operationId) selectedId = request.id
        }
        upstream.write(line + '\n')
      }
    })
    upstream.on('data', bytes => {
      pendingReply += bytes.toString('utf8')
      let end: number
      while ((end = pendingReply.indexOf('\n')) >= 0) {
        const line = pendingReply.slice(0, end); pendingReply = pendingReply.slice(end + 1)
        const reply = JSON.parse(line) as Frame
        if (selectedId !== undefined && reply.id === selectedId) {
          dropped.push(reply)
          // Core has returned its original native ACK. Only this response reader
          // is lost; no Runtime/PTY hook, authority callback or input is replaced.
          downstream.end(); upstream.destroy(); return
        }
        downstream.write(line + '\n')
      }
    })
    downstream.once('end', () => upstream.end())
    downstream.once('close', () => upstream.destroy())
    upstream.once('end', () => downstream.end())
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(socketPath, yes) })
  return { requests, dropped, errors, async close() {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()))
  } }
}

describe('trusted call native proof', () => {
  it('rejects wire-supplied authority and preserves one physical dispatch after the original reply is lost', async () => {
    // The production CLI has no fixture writeTerminal wrapper: trusted call
    // arguments and the actual Core/ctxmux path are consumed without replacement.
    const scope = await headlessFixture({ cli: true }); cleanup.push(() => scope.cleanup())
    const local = await scope.client(), received = join(scope.root, 'received.bytes')
    const run = await local.createTerminal({ createOperationId: 'trusted-native-terminal', workspacePath: scope.root,
      command: process.execPath, args: [resolve('apps/desktop/test/fixtures/input-authority-pty.mjs'), received], cols: 80, rows: 24 })
    expect(run.pid).toBeGreaterThan(0); pids.push(run.pid!)
    await until(() => readFile(received).catch(() => null), value => value !== null, 'private raw PTY ready')
    const owner = scope.owner, original = await local.readRunReplay({ runId: run.runId })
    expect(original.run.acceptedInputBytes).toBe(0)
    const operation = { ownerInstanceId: local.runtimeIdentity().instanceId, operationId: 'original-lost-reply',
      expectedByte: 0, data: 'original-raw-雪' }
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => rpc.dispose())
    await expect(rpc.call('runtime.invoke', { consumerId: 'forged-context',
      fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId },
      invocation: encodeHostedValue({ method: 'writeTerminal', args: [{ runId: run.runId },
        { ...operation, operationId: 'forged-authority', data: 'must-not-write' }, undefined,
        { author: { kind: 'user' }, assertCurrent: 'wire-is-not-authority' }] }) as AgentMuxHostedInvocation
    })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(await readFile(received)).toEqual(Buffer.alloc(0))
    expect((await local.readRunReplay({ runId: run.runId })).run.acceptedInputBytes).toBe(0)

    const proxy = await lostReplyProxy(join(scope.root, 'lost.sock'), scope.socketPath, operation.operationId)
    cleanup.push(() => proxy.close())
    const remoteRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(scope.root, 'lost.sock') } })
    cleanup.push(() => remoteRpc.dispose())
    const remote = await scope.client(remoteRpc)
    cleanup.push(() => remote.dispose())
    const failure = await remote.writeTerminal({ runId: run.runId }, operation).then(() => null, error => error)
    expect(failure).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(isAgentMuxRpcReplyUnconfirmed(failure)).toBe(true)
    expect(proxy.dropped).toHaveLength(1)
    const firstBytes = Buffer.from(operation.data)
    expect(proxy.dropped[0]).toMatchObject({ result: { value: { runId: run.runId,
      appliedByteRange: { startByte: 0, endByte: firstBytes.length }, acceptedThroughByte: firstBytes.length } } })
    expect(await until(() => readFile(received), value => value.length >= firstBytes.length, 'original dispatch reached physical PTY')).toEqual(firstBytes)
    const confirmed = await local.readRunReplay({ runId: run.runId })
    expect(confirmed.run).toMatchObject({ runId: run.runId, pid: run.pid, state: 'running', acceptedInputBytes: firstBytes.length })

    await remote.dispose(); await remoteRpc.dispose()
    const reconnectedRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(scope.root, 'lost.sock') } })
    cleanup.push(() => reconnectedRpc.dispose())
    const reconnected = await scope.client(reconnectedRpc); cleanup.push(() => reconnected.dispose())
    expect(reconnected.runtimeOwnerIdentity()).toMatchObject({ runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId })
    expect((await reconnected.readRunReplay({ runId: run.runId })).run).toMatchObject({ pid: run.pid, acceptedInputBytes: firstBytes.length })
    const following = { ...operation, operationId: 'explicit-following-input', expectedByte: firstBytes.length, data: '\x1b[<64;10;20M' }
    const allBytes = Buffer.concat([firstBytes, Buffer.from(following.data)])
    await expect(reconnected.writeTerminal({ runId: run.runId }, following)).resolves.toEqual({ runId: run.runId,
      appliedByteRange: { startByte: firstBytes.length, endByte: allBytes.length }, acceptedThroughByte: allBytes.length })
    expect(await until(() => readFile(received), value => value.length >= allBytes.length, 'new explicit input after reconnect')).toEqual(allBytes)

    // Existing CLI surface is read-only here. Raw input stays with its existing
    // SDK/Renderer consumers; no raw-byte CLI command is invented for coverage.
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${scope.socketPath}`, 'system', 'storage', '--host', 'local', '--run', run.runId], scope.env)
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result).toMatchObject({ run: { runId: run.runId }, status: 'observed',
      runtime: { hostId: 'local', instanceId: operation.ownerInstanceId } })
    const final = await local.readRunReplay({ runId: run.runId })
    expect(final.run).toMatchObject({ runId: run.runId, pid: run.pid, state: 'running', acceptedInputBytes: allBytes.length })
    expect(await readFile(received)).toEqual(allBytes)
    const writes = proxy.requests.filter(frame => frame.params?.invocation?.method === 'writeTerminal')
    expect(writes.map(frame => (frame.params!.invocation!.args[1] as { operationId: string }).operationId))
      .toEqual([operation.operationId, following.operationId])
    expect(proxy.errors).toEqual([])
    facts.push({ owner, runId: run.runId, pid: run.pid, originalOperation: operation,
      requestIds: writes.map(frame => frame.id), replyLost: true, replyUnconfirmed: isAgentMuxRpcReplyUnconfirmed(failure),
      interceptedNativeAck: proxy.dropped[0], expectedHex: allBytes.toString('hex'), acceptedInputBytes: final.run.acceptedInputBytes,
      rawDispatchCount: writes.length, rejectedWireAuthorityBytes: 0, existingCli: 'system storage', cliCode: cli.code })
  })
})
