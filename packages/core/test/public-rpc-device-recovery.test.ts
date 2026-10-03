import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxRpcClient } from '../src/public-rpc-client.js'

// Exercise the normal build consumed by the real CLI, including its error class.
const { connectAgentMuxRpc } = await import('../dist/public-rpc-client.js') as {
  connectAgentMuxRpc: typeof import('../src/public-rpc-client.js').connectAgentMuxRpc
}
const { AgentMuxError } = await import('../dist/errors.js') as typeof import('../src/errors.js')
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function http(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind')
  return { transport: 'http' as const, token: 'private-device-advice-fixture', url: `http://127.0.0.1:${address.port}/` }
}
async function client(endpoint: NonNullable<NonNullable<Parameters<typeof connectAgentMuxRpc>[0]>['endpoint']>): Promise<AgentMuxRpcClient> {
  const value = await connectAgentMuxRpc({ endpoint }); cleanup.push(() => value.dispose()); return value
}
const controlFailure = { disposition: 'unknown' as const, confirmedInputBytes: null }

describe('device recovery advice at the public client and CLI boundary', () => {
  it('gives a remote hello caller reachable advice without replaying the failed request', async () => {
    let requests = 0
    const endpoint = await http((_request, response) => { requests++; response.writeHead(503); response.end() })
    const failure = await (await client(endpoint)).call('device.hello', { name: 'Device' }).catch(error => error)
    expect(failure.code).toBe('CONTROL_UNAVAILABLE')
    expect(failure.message).toContain("Check this device's connection state")
    expect(failure.message).toContain('ask a local user')
    expect(failure.message).not.toContain('Read agentmux device ls')
    expect(failure.message).toContain('Never automatically replay a write')
    expect(requests).toBe(1)
  })
  it('retains the original local-user reconciliation command on an unavailable Unix endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amx-device-advice-'))
    cleanup.push(() => rm(directory, { recursive: true }))
    const failure = await (await client({ transport: 'unix', path: join(directory, 'missing.sock') })).call('device.ls', {}).catch(error => error)
    expect(failure.code).toBe('CONTROL_UNAVAILABLE')
    expect(failure.message).toContain('Read agentmux device ls')
    expect(failure.message).toContain('Never automatically replay a write')
  })
  it('keeps remote device management rejected before any connection or submission', async () => {
    let requests = 0
    const endpoint = await http((_request, response) => { requests++; response.end() })
    await expect((await client(endpoint)).call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(requests).toBe(0)
  })
  it('preserves typed pre-response error facts while adding role-appropriate advice', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new AgentMuxError('Original transport issue', 'CONTROL_OWNER_BUSY', 'original detail', controlFailure))
    const failure = await (await client({ transport: 'http', url: 'http://127.0.0.1:1/', token: 'private-device-advice-fixture' })).call('device.hello', { name: 'Device' }).catch(error => error)
    expect(failure).toMatchObject({ code: 'CONTROL_OWNER_BUSY', detail: 'original detail', controlFailure })
    expect(failure.message).toContain('Original transport issue')
    expect(failure.message).toContain('ask a local user')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps an original business failure intact without appending transport recovery advice', async () => {
    let requests = 0
    const endpoint = await http((request, response) => {
      requests++; let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, error: {
          code: -32000, message: 'Original business issue', data: { code: 'CONTROL_OWNER_BUSY', detail: 'original detail', controlFailure }
        } }))
      })
    })
    const failure = await (await client(endpoint)).call('device.hello', { name: 'Device' }).catch(error => error)
    expect(failure).toMatchObject({ code: 'CONTROL_OWNER_BUSY', detail: 'original detail', controlFailure, message: 'Original business issue' })
    expect(requests).toBe(1)
  })
  it('retains the original internal Toolkit target guard after removing its unreachable duplicate', async () => {
    const { assertControlResultTarget } = await import('../dist/rpc-business-codec.js') as typeof import('../src/rpc-business-codec.js')
    const { AGENTMUX_CONTROL_SCHEMA_VERSION } = await import('../dist/control.js') as typeof import('../src/control.js')
    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-operation', operation: 'toolkit.remove' as const, toolId: 'selected-tool' }
    expect(() => assertControlResultTarget(request, { operation: 'toolkit.remove', toolId: 'another-tool', removed: true })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => assertControlResultTarget(request, { operation: 'toolkit.remove', toolId: 'selected-tool', removed: true })).not.toThrow()
  })
  it('reports the same accurate failure through the actual compiled CLI', async () => {
    let requests = 0
    const endpoint = await http((_request, response) => { requests++; response.writeHead(503); response.end() })
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTMUX_RPC_HTTP_TOKEN: 'private-device-advice-fixture' }
    delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
    const failure = await promisify(execFile)(process.execPath,
      [new URL('../bin/agentmux', import.meta.url).pathname, '--endpoint', endpoint.url, 'device', 'hello', '--name', 'Device'], { env }).catch(error => error)
    expect(failure.code).toBe(1)
    const receipt = JSON.parse(failure.stderr)
    expect(receipt).toMatchObject({ ok: false, operation: 'device.hello', error: { code: 'CONTROL_UNAVAILABLE' } })
    expect(receipt.error.message).toContain('ask a local user')
    expect(receipt.error.message).not.toContain('Read agentmux device ls')
    expect(requests).toBe(1)
  })
})
