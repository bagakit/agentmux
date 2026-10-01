import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc,
  type ProcessRunner, type AgentMuxRpcClient } from '@agentmux/core'
import { startAgentMuxHost } from '../src/host.js'
import { createMacDeviceConfirmation } from '../src/mac-device-confirmation.js'
import { preparePrivateCertificates } from '../src/private-certificates.js'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-device-administration-'))
  await mkdir(join(root, 'home/codex'), { recursive: true })
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), CODEX_HOME: join(root, 'home/codex'),
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })) vi.stubEnv(key, value)
})
afterAll(async () => {
  const cleanup = await import(pathToFileURL(resolve('apps/desktop/scripts/probe-process.mjs')).href) as {
    listProbeProcesses(group: number, root: string): Promise<number[]>
    signalOwnedProbeProcess(pid: number, root: string, name: NodeJS.Signals): Promise<boolean>
  }
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of await cleanup.listProbeProcesses(process.pid + 1_000_000_000, root)) await cleanup.signalOwnedProbeProcess(pid, root, name)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  expect(await cleanup.listProbeProcesses(process.pid + 1_000_000_000, root)).toEqual([])
  vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
})

it('joins all five actual Unix methods to the one original Authority and fixed native runner, with cancellation retaining existing authorization', async () => {
  const directory = join(root, 'unix'); await mkdir(directory)
  let cancel = false
  const run: ProcessRunner = vi.fn(async (_command, args) => ({ stdout: `${args.at(-1)}:${cancel ? 'cancelled' : 'confirmed'}\n`, stderr: '', exitCode: 0 }))
  const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json')),
    socketPath: join(directory, 'control.sock'), deviceConfirmation: createMacDeviceConfirmation({ run, platform: 'darwin' }) })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'control.sock') } })
  try {
    const authority = await host.deviceAuthority()
    await expect(rpc.call('device.ls', {})).resolves.toEqual({ hostId: authority.hostId, devices: [], requests: [], privateAccess: host.privateAccessState() })
    const invitation = await rpc.call('device.invite', {})
    expect(invitation).toEqual(expect.objectContaining({ hostId: authority.hostId, invitation: expect.any(String), expiresAt: expect.any(Number) }))
    const pending = authority.begin(invitation.hostId, invitation.invitation, 'Original approved iPhone')
    expect((await rpc.call('device.ls', {})).requests).toEqual([{
      device: { deviceId: pending.deviceId, name: 'Original approved iPhone', createdAt: expect.any(Number) },
      confirmationCode: pending.confirmationCode, expiresAt: pending.expiresAt
    }])
    const approved = await rpc.call('device.approve', { deviceId: pending.deviceId, confirmationCode: pending.confirmationCode })
    expect(approved).toEqual({ hostId: authority.hostId, device: authority.devices()[0] })
    expect(authority.devices()).toHaveLength(1)
    const original = await readFile(join(directory, 'agentmux-devices.json'))
    cancel = true
    await expect(rpc.call('device.revoke', { deviceId: pending.deviceId })).rejects.toMatchObject({ code: 'DEVICE_CONFIRMATION_CANCELLED' })
    expect(await readFile(join(directory, 'agentmux-devices.json'))).toEqual(original)
    cancel = false
    const refusedInvite = await rpc.call('device.invite', {}), refused = authority.begin(refusedInvite.hostId, refusedInvite.invitation, 'Original refused device')
    expect(await rpc.call('device.reject', { deviceId: refused.deviceId })).toEqual({ hostId: authority.hostId, deviceId: refused.deviceId, state: 'denied' })
    expect(authority.requests()).toEqual([])
    expect(await rpc.call('device.revoke', { deviceId: pending.deviceId })).toEqual({ hostId: authority.hostId, device: authority.devices()[0] })
    expect(authority.devices()).toEqual([{ ...approved.device, revokedAt: expect.any(Number) }])
    expect(vi.mocked(run).mock.calls.map(call => call[1][3])).toEqual(['invite', 'approve', 'revoke', 'invite', 'reject', 'revoke'])
    for (const [command, args, options] of vi.mocked(run).mock.calls) {
      expect(command).toBe('/usr/bin/osascript'); expect(args.slice(0, 3)).toEqual(['-l', 'AppleScript', '-'])
      expect(args[4]).toBe(authority.hostId); expect(args[8]).toMatch(/^[a-f0-9]{32}$/u)
      expect(options!.input).toContain('读取、发送、启动和停止')
      expect(options!.signal).toBeInstanceOf(AbortSignal)
    }
  } finally { await rpc.dispose(); await host.dispose() }
})

it('rejects approved HTTP devices and forged caller facts before native confirmation or Authority mutation, while retaining genuine Unix diagnostics', async () => {
  const directory = join(root, 'http'); await mkdir(directory)
  const material = await preparePrivateCertificates(join(directory, 'certificates'), '127.0.0.1')
  const ca = await readFile(join(material.directory, 'issuer.pem')), blocker = createServer()
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const address = blocker.address(); if (!address || typeof address === 'string') throw new Error('No private port')
  await new Promise<void>(resolve => blocker.close(() => resolve()))
  const confirm = vi.fn(async () => 'confirmed' as const)
  const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json')),
    socketPath: join(directory, 'control.sock'), privateAccess: { host: '127.0.0.1', port: address.port,
      keyPath: material.keyPath, certificatePath: material.certificatePath }, deviceConfirmation: confirm })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'control.sock') } })
  let managed: AgentMuxRpcClient | undefined
  try {
    const authority = await host.deviceAuthority(), state = host.privateAccessState()
    if (state.state !== 'listening') throw new Error('Original private HTTPS was unavailable')
    const invitation = authority.invite(), pending = authority.begin(authority.hostId, invitation.invitation, 'Approved isolated HTTP device')
    await authority.approve(pending.deviceId, pending.confirmationCode)
    const claimed = authority.claim(pending.hostId, pending.deviceId, pending.claim)
    if (claimed.state !== 'approved') throw new Error('Controlled original device admission was not confirmed')
    const original = await readFile(join(directory, 'agentmux-devices.json'))
    const send = (method: string, params: object) => new Promise<{ status: number; result: unknown }>((resolve, reject) => {
      const request = httpsRequest(`${state.origin}/`, { method: 'POST', ca, headers: {
        'Content-Type': 'application/json', 'X-AgentMux-Transport': 'native',
        Authorization: `AgentMuxDevice ${authority.hostId}.${claimed.credential}`
      } }, response => {
        const chunks: Buffer[] = []; response.on('data', value => chunks.push(value))
        response.once('end', () => resolve({ status: response.statusCode!, result: JSON.parse(Buffer.concat(chunks).toString()) }))
      })
      request.once('error', reject); request.end(JSON.stringify({ jsonrpc: '2.0', id: 'original-device-request', method, params }))
    })
    for (const method of ['device.ls', 'device.invite', 'device.approve', 'device.reject', 'device.revoke']) {
      expect(await send(method, {})).toMatchObject({ status: 200, result: { error: { data: { code: 'CONTROL_PERMISSION_DENIED' } } } })
    }
    managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'control.sock') },
      credentials: { agentSessionId: 'unapproved-managed-sender', capability: 'unapproved-managed-capability' } })
    await expect(managed.call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(rpc.call('device.invite', { confirmed: true } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(confirm.mock.calls).toEqual([])
    expect(await readFile(join(directory, 'agentmux-devices.json'))).toEqual(original)
    expect(await rpc.call('device.ls', {})).toEqual({ hostId: authority.hostId, devices: authority.devices(), requests: [], privateAccess: host.privateAccessState() })
    expect(await rpc.call('runtime.bootstrap', { consumerId: 'unaffected-unix-client' })).toMatchObject({ identity: host.client!.runtimeIdentity() })
    expect(host.client!.agentSessions()).toEqual([])
  } finally { await managed?.dispose(); await rpc.dispose(); await host.dispose() }
})
