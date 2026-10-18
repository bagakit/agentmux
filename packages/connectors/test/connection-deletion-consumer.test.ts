import { registerConnectorIpc } from '../../../apps/desktop/src/main/connector-ipc.js'
import { unwrapSessionInputOperationResult } from '../../../apps/desktop/src/shared/session-input-result.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxRpcService } from '../../core/src/public-rpc-service.js'
import { AgentMuxError } from '../../core/src/index.js'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { ConnectionHost } from '../src/connection-host.js'

const clean: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'identity-removal-'))
  clean.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'connections.sqlite')
  const options = { databasePath: path, secrets: { resolve: async () => null } }
  let owner = new ConnectionHost(options)
  clean.push(() => owner.close())
  const first = { connectionId: 'first-bot', adapterId: 'sample', application: { domain: 'chat.example', appId: 'app-first' },
    label: 'Same bot name', enabled: true, credentialRef: 'original-secret-ref' }
  const second = { ...first, connectionId: 'second-bot', application: { ...first.application, appId: 'app-second' } }
  for (const connection of [first, second]) await owner.configure({ operationId: `save-${connection.connectionId}`, expectedRevision: null, connection })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'public.sock'), connections: owner,
    coreClients: () => { throw Error('Identity removal must not borrow or alter an Agent Runtime') } })
  await server.start(); clean.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  clean.push(() => client.dispose())
  const cli = (args: string[], input = '') => runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'connection', ...args], objectCliEnvironment(root), input)
  return { first, second, client, cli, owner, server, reopen: () => { owner.close(); owner = new ConnectionHost(options); return owner } }
}

describe('local identity deletion through original public consumers', () => {
  it('removes only the exact identity through the compiled CLI and retains its original receipt across restart', async () => {
    const f = await fixture(), input = { operationId: 'remove-first', connectionId: f.first.connectionId, expectedRevision: 1 }
    const result = await f.cli(['delete', '--input', '-'], JSON.stringify(input))
    expect(result.code, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout).result
    expect(receipt).toEqual({ operationId: input.operationId, status: 'deleted', connectionId: f.first.connectionId,
      application: f.first.application, deletedRevision: 1 })
    expect((await f.client.call('connection.ls', {})).connections.map(r => r.config.connectionId)).toEqual([f.second.connectionId])
    const inspection = await f.cli(['delete', 'inspect', '--operation-id', input.operationId])
    expect(inspection.code, inspection.stderr).toBe(0)
    expect(JSON.parse(inspection.stdout).result).toEqual({ operation: receipt })
    const restored = f.reopen()
    expect(await restored.inspectDeletion({ operationId: input.operationId })).toEqual({ operation: receipt })
    expect(await restored.delete(input)).toEqual(receipt)
    expect((await restored.inspect({ operationId: 'save-first-bot' })).operation?.connection.config).toEqual(f.first)
    expect((await restored.list()).connections.map(r => r.config.connectionId)).toEqual([f.second.connectionId])
  })

  it('refuses a stale target before any delete and never repurposes a removed identity', async () => {
    const f = await fixture()
    await f.owner.configure({ operationId: 'rename-first', expectedRevision: 1, connection: { ...f.first, label: 'Changed name' } })
    await expect(f.client.call('connection.delete', { operationId: 'stale-remove', connectionId: f.first.connectionId, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
    expect((await f.client.call('connection.ls', {})).connections).toHaveLength(2)
    expect(await f.client.call('connection.delete.inspect', { operationId: 'stale-remove' })).toEqual({ operation: null })
    await f.client.call('connection.delete', { operationId: 'remove-current', connectionId: f.first.connectionId, expectedRevision: 2 })
    await expect(f.owner.configure({ operationId: 'repurpose-first', expectedRevision: null, connection: f.first }))
      .rejects.toMatchObject({ code: 'CONNECTION_IDENTITY_DELETED' })
    await expect(f.owner.delete({ operationId: 'remove-current', connectionId: f.second.connectionId, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
    expect((await f.owner.list()).connections.map(r => r.config.connectionId)).toEqual([f.second.connectionId])
  })
  it('checks the original operator again after a delayed owner acquisition and before deletion', async () => {
    const f = await fixture()
    let revoked = false
    const connections = Object.create(f.owner) as typeof f.owner
    connections.delete = async (input, context) => {
      await Promise.resolve()
      revoked = true
      return await f.owner.delete(input, context)
    }
    const service = new AgentMuxRpcService({ connections })
    await expect(service.call('connection.delete', { operationId: 'remove-after-revocation', connectionId: f.first.connectionId, expectedRevision: 1 }, {
      principal: { kind: 'user', id: 'original-operator' },
      assertCurrent: () => { if (revoked) throw new AgentMuxError('Original operator revoked.', 'CONTROL_PERMISSION_DENIED') }
    })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect((await f.owner.list()).connections.map(row => row.config.connectionId)).toEqual([f.first.connectionId, f.second.connectionId])
    expect(await f.owner.inspectDeletion({ operationId: 'remove-after-revocation' })).toEqual({ operation: null })
  })

  it('preserves a structured revision refusal through the actual settings IPC and Preload decoder', async () => {
    const f = await fixture(), sender = { originalRenderer: true }
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    registerConnectorIpc({ socketPath: f.server.path,
      handleWithEvent: (channel, handler) => handlers.set(channel, handler),
      assertTrusted: (_channel, event) => expect(event).toBe(sender),
      secrets: { store: async () => { throw Error('No credentials are changed') }, inspect: async () => null } })
    await f.owner.configure({ operationId: 'change-before-removal', expectedRevision: 1, connection: { ...f.first, label: 'New label' } })
    const original = { operationId: 'remove-previous-revision', connectionId: f.first.connectionId, expectedRevision: 1 }
    const envelope = await handlers.get('connections:call')!(sender, 'connection.delete', original)
    expect(() => unwrapSessionInputOperationResult(structuredClone(envelope) as never)).toThrow(expect.objectContaining({ code: 'CONNECTION_REVISION_CONFLICT' }))
    expect((await f.owner.list()).connections).toHaveLength(2)
    expect(await f.owner.inspectDeletion({ operationId: original.operationId })).toEqual({ operation: null })
  })

})
