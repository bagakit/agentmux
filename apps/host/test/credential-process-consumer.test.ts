import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const secret = '\ufeffprivate-node-credential-你好\nverbatim-trailing-space '
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-private-host-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = { ...objectCliEnvironment(root), pnpm_config_verify_deps_before_run: 'false',
    ...(process.env.AGENTMUX_CREDENTIAL_MUTANT ? { AGENTMUX_CREDENTIAL_MUTANT: process.env.AGENTMUX_CREDENTIAL_MUTANT } : {}),
    ...(process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT ? { AGENTMUX_CREDENTIAL_SOURCE_REPORT: process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT } : {}) }
  async function start() {
    const child = fork(resolve(import.meta.dirname, 'fixtures/credential-owner.mjs'), [root], { execArgv: ['--experimental-transform-types', '--import', resolve(import.meta.dirname, 'credential-node-loader.mjs')], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stderr = '', stdout = '', seq = 0
    child.stderr!.on('data', chunk => { stderr += String(chunk) }); child.stdout!.on('data', chunk => { stdout += String(chunk) })
    const pending = new Map<number, { accept(value: any): void; reject(error: unknown): void }>()
    let ready!: (value: any) => void, fail!: (error: unknown) => void
    const opened = new Promise<any>((accept, reject) => { ready = accept; fail = reject })
    child.on('message', (message: any) => { if (message.kind === 'ready') return ready(message)
      const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id)
      if (message.error) handler.reject(message.error); else handler.accept(message.value)
    })
    child.once('exit', code => { const error = Error(`Actual Node Host exited ${code}: ${stderr}`); fail(error); for (const handler of pending.values()) handler.reject(error) })
    const call = (operation: string, input?: Record<string, unknown>) => new Promise<any>((accept, reject) => { const id = ++seq; pending.set(id, { accept, reject }); child.send({ id, operation, input }) })
    const close = async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exit = new Promise(done => child.once('exit', done)); try { await call('stop') } finally { await exit } }
    cleanup.push(close)
    const first = await opened; expect(first.pid).not.toBe(process.pid)
    const rpc = async (managed = false) => { const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'host.sock') }, ...(managed ? { credentials: { agentSessionId: 'managed-agent', capability: first.capability } } : {}) }); cleanup.push(() => client.dispose()); return client }
    return { ...first, fence: { runtimeId: first.owner.runtimeId, ownerInstanceId: first.owner.ownerInstanceId }, rpc, call, close, child: child as ChildProcess, logs: () => stdout + stderr }
  }
  return { root, env, start, cli: (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', 'unix:' + join(root, 'host.sock'), ...args], { ...env, AGENTMUX_CREDENTIAL_COMPILED_ONLY: 'true', NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(resolve(import.meta.dirname, 'credential-node-loader.mjs')).href }, stdin) }
}

it('actual startAgentMuxHost public RPC and compiled stdin CLI use the original owner across a separate Node restart', async () => {
  const f = await fixture(), first = await f.start(), client = await first.rpc(), options = { runtimeFence: first.fence }
  const help = await f.cli(['connection', 'credential', 'store', '--help'])
  expect(help.code, help.stdout + help.stderr).toBe(0); expect(help.stdout).toContain('--secret-stdin'); expect(help.stdout).not.toContain('credential key')
  const result = await f.cli(['connection', 'credential', 'store', '--operation-id', 'original-node-operation', '--secret-stdin'], secret)
  expect(result.code, result.stdout + result.stderr).toBe(0); const receipt = JSON.parse(result.stdout).result
  expect(Object.keys(receipt)).toEqual(['credentialRef']); expect(result.stdout + result.stderr).not.toContain('private-node-credential-')
  expect(await client.call('connection.credential.inspect', { operationId: 'original-node-operation' }, options)).toEqual({ receipt })
  const connection = { connectionId: 'original-private-connection', adapterId: 'private-consumer', application: { domain: 'private.example', appId: createHash('sha256').update(secret).digest('hex') }, label: 'Original', enabled: true, credentialRef: receipt.credentialRef }
  await client.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection })
  expect(await client.call('connection.test', { connectionId: connection.connectionId })).toMatchObject({ observation: { authentication: { state: 'ready' } } })
  const diagnosis = await client.call('connection.diagnose', { executionHostId: 'local', agentSessionId: 'managed-agent' })
  expect(JSON.stringify(diagnosis)).not.toContain('private-node-credential-')
  const device = await first.call('device-store', { operationId: 'device-original-operation', secret })
  expect(device.reply).toMatchObject({ result: { credentialRef: expect.any(String) } }); expect(device.reply.error).toBeUndefined()
  expect(device.device.operations).toEqual([]); expect(JSON.stringify(device)).not.toContain('private-node-credential-')
  await client.dispose(); const facts = await first.call('facts')
  expect(facts.devices).not.toContain('private-node-credential-'); expect(first.logs()).not.toContain('private-node-credential-')
  await first.close()
  const reopened = await f.start(); expect(reopened.owner.runtimeId).toBe(first.owner.runtimeId); expect(reopened.owner.ownerInstanceId).not.toBe(first.owner.ownerInstanceId)
  const next = await reopened.rpc()
  await expect(next.call('connection.credential.store', { operationId: 'wrong-old-owner', secret }, options)).rejects.toHaveProperty('code')
  const inspected = await f.cli(['connection', 'credential', 'inspect', '--operation-id', 'original-node-operation'])
  expect(inspected.code).toBe(0); expect(JSON.parse(inspected.stdout).result).toEqual({ receipt })
  const repeated = await f.cli(['connection', 'credential', 'store', '--operation-id', 'original-node-operation', '--secret-stdin'], secret)
  expect(repeated.code).toBe(0); expect(JSON.parse(repeated.stdout).result).toEqual(receipt)
  expect(await next.call('connection.test', { connectionId: connection.connectionId })).toMatchObject({ observation: { authentication: { state: 'ready' } } })
  expect((await stat(join(f.root, 'connections'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(f.root, 'connections', 'connections.sqlite'))).mode & 0o777).toBe(0o600)
  expect(await readFile(join(f.root, 'connections', 'connections.sqlite'))).not.toHaveLength(0)
  expect(reopened.logs() + inspected.stdout + inspected.stderr).not.toContain('private-node-credential-')
})

it('competing compiled CLI clients converge on one operation/ref while changed input conflicts without secret reflection', async () => {
  const f = await fixture(), host = await f.start(), args = ['connection', 'credential', 'store', '--operation-id', 'competing-operation', '--secret-stdin']
  const attempts = await Promise.all([f.cli(args, secret), f.cli(args, secret), f.cli(args, secret)])
  expect(attempts.map(value => value.code)).toEqual([0, 0, 0])
  const refs = attempts.map(value => JSON.parse(value.stdout).result.credentialRef); expect(new Set(refs).size).toBe(1)
  const conflict = await f.cli(args, 'changed-' + secret)
  expect(conflict.code).not.toBe(0); expect(conflict.stderr).toContain('CONNECTION_OPERATION_CONFLICT')
  expect(conflict.stdout + conflict.stderr + host.logs()).not.toContain('private-node-credential-')
  const client = await host.rpc(); expect(await client.call('connection.credential.inspect', { operationId: 'competing-operation' }, { runtimeFence: host.fence })).toEqual({ receipt: { credentialRef: refs[0] } })
})

it('the real public Host denies managed callers or missing/wrong fences before dispatching its credential port', async () => {
  const f = await fixture(), host = await f.start(), person = await host.rpc(), managed = await host.rpc(true)
  const before = (await host.call('facts')).credentialCalls
  await expect(managed.call('connection.credential.store', { operationId: 'agent-denied', secret }, { runtimeFence: host.fence })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(person.call('connection.credential.store', { operationId: 'no-fence', secret })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(person.call('connection.credential.store', { operationId: 'wrong-fence', secret }, { runtimeFence: { ...host.fence, runtimeId: 'foreign-runtime' } })).rejects.toHaveProperty('code')
  expect((await host.call('facts')).credentialCalls).toBe(before)
  expect(await person.call('connection.credential.inspect', { operationId: 'agent-denied' }, { runtimeFence: host.fence })).toEqual({ receipt: null })
  expect((await person.call('connection.ls', {})).connections).toEqual([])
  expect((await host.call('facts')).devices + host.logs()).not.toContain('private-node-credential-')
})

it('refuses this secret write before any HTTP network I/O and keeps ordinary transport operations usable', async () => {
  let requests = 0, received = ''
  const server = createServer(async (request, response) => { requests++; for await (const chunk of request) received += chunk
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(received).id, error: { code: -32000, message: 'Controlled HTTP response', data: { code: 'CONTROL_PERMISSION_DENIED' } } }))
  }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Controlled HTTP listener absent')
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: 'http://127.0.0.1:' + address.port + '/', token: 'synthetic-http-token' } }); cleanup.push(() => client.dispose())
  await expect(client.call('connection.credential.store', { operationId: 'http-denied', secret }, { runtimeFence: { runtimeId: 'original', ownerInstanceId: 'original' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(requests).toBe(0); expect(received).not.toContain('private-node-credential-')
  await expect(client.call('connection.credential.inspect', { operationId: 'http-denied' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(requests).toBe(1); expect(received).not.toContain('private-node-credential-')
})
