import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectAgentMuxRpc as connectBuilt } from '../dist/public-rpc-client.js'
import { AgentMuxError } from '../src/errors.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.each([['source', connectAgentMuxRpc], ['compiled', connectBuilt]] as const)(
  '%s keeps authorization capacity and service failures distinct from invalid credentials', async (_name, connect) => {
    const root = await mkdtemp(fixturePath("tmp/amx-http-authorization-"))
    let failure: Error | null | undefined
    const token = 'original-private-http-token', received: string[] = []
    const coreClients = vi.fn(() => []), execute = vi.fn()
    const owner = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients, execute,
      http: { host: '127.0.0.1', port: 0, authorize(request) {
        const header = request.headers.get('authorization')
        expect(header).toBe(`Bearer ${token}`); received.push(header!)
        if (failure) throw failure
        return failure === null ? null : { principal: { kind: 'device', id: 'approved-original-device' } }
      } } })
    await owner.start()
    cleanup.push(async () => { await owner.stop(); await rm(root, { recursive: true, force: true }) })
    const url = `http://127.0.0.1:${owner.httpAddress!.port}/`
    const client = await connect({ endpoint: { transport: 'http', url, token } })
    cleanup.push(() => client.dispose())
    const cases = [
      { failure: null, status: 401, code: 'AGENT_CAPABILITY_INVALID' },
      { failure: new AgentMuxError('Original authorization denied.', 'CONTROL_PERMISSION_DENIED'), status: 401, code: 'AGENT_CAPABILITY_INVALID' },
      { failure: new AgentMuxError('Original credential denied.', 'AGENT_CAPABILITY_INVALID'), status: 401, code: 'AGENT_CAPABILITY_INVALID' },
      { failure: new AgentMuxError('Original device observer capacity is full.', 'CONTROL_OWNER_BUSY'), status: 429, code: 'CONTROL_OWNER_BUSY' },
      { failure: new AgentMuxError('Original authorization service is unavailable.', 'CONTROL_UNAVAILABLE'), status: 503, code: 'CONTROL_UNAVAILABLE' },
      { failure: new Error('Original authorization outcome is unknown.'), status: 503, code: 'CONTROL_UNAVAILABLE' }
    ]
    expect(cases).toHaveLength(6)
    for (const item of cases) {
      failure = item.failure
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'original-read', method: 'system.endpoint', params: {} }) })
      expect(response.status).toBe(item.status)
      await response.body?.cancel()
      await expect(client.call('system.endpoint', {})).rejects.toMatchObject({ code: item.code })
    }
    expect(coreClients).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
    failure = undefined
    expect((await client.call('system.endpoint', {})).protocol).toBe('jsonrpc-2.0')
    expect(received).toEqual(Array(13).fill(`Bearer ${token}`))
    const local = await connect({ endpoint: { transport: 'unix', path: owner.path } })
    cleanup.push(() => local.dispose())
    expect((await local.call('system.endpoint', {})).protocol).toBe('jsonrpc-2.0')
    expect(coreClients).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
  })
