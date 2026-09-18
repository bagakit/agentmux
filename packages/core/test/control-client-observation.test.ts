import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  AgentMuxControlServer, parseAgentMuxControlRequest, parseAgentMuxControlReceipt,
  requestAgentMuxControl, type AgentMuxControlInspectClientRequest
} from '../src/index.js'

const request: AgentMuxControlInspectClientRequest = { schemaVersion: 5, requestId: 'private-client-observation', operation: 'inspect.client' }
const roots: string[] = []
const servers: AgentMuxControlServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('carries a nonempty host-owned observation through the actual public Control socket without interpreting its layout', async () => {
  const root = await mkdtemp('/tmp/amx-client-observation-'); roots.push(root)
  const socket = join(root, 'control.sock')
  const observation = { schema: 'private.client-observation', loading: true,
    regions: [{ id: 'original-region', attached: false }], renderer: null }
  const requests: unknown[] = []
  const server = new AgentMuxControlServer({ execute: async received => {
    requests.push(received)
    return { operation: 'inspect.client', observation }
  } }, socket)
  servers.push(server); await server.start()
  expect(await requestAgentMuxControl(request, socket)).toEqual({ schemaVersion: 5,
    requestId: request.requestId, ok: true, operation: 'inspect.client', result: { observation } })
  expect(requests).toEqual([request])
})

it('rejects effects and caller/target fields on the observation-only request', () => {
  expect(parseAgentMuxControlRequest(request)).toEqual(request)
  const invalid = [{ ...request, target: { kind: 'self' } }, { ...request, caller: { agentSessionId: 'private-agent' } },
    { ...request, flush: true }]
  expect(invalid).toHaveLength(3)
  for (const value of invalid) expect(() => parseAgentMuxControlRequest(value))
    .toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
})

it('requires an object receipt while leaving concrete host metadata to the host validator', () => {
  const receipt = { schemaVersion: 5, requestId: request.requestId, ok: true, operation: 'inspect.client',
    result: { observation: { schema: 'private.client-observation', regions: [{ id: 'kept' }] } } }
  expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
  const invalid = [null, [], 'not metadata']
  expect(invalid).toHaveLength(3)
  for (const observation of invalid) expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { observation } }))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { ...receipt.result, committed: true } }))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})

it('returns an explicit error when a complete observation exceeds the existing framing budget', async () => {
  const root = await mkdtemp('/tmp/amx-client-budget-'); roots.push(root)
  const socket = join(root, 'control.sock')
  const server = new AgentMuxControlServer({ execute: async () => ({ operation: 'inspect.client',
    observation: { originalRegions: ['retained'], metadata: 'x'.repeat(256 * 1024) } }) }, socket)
  servers.push(server); await server.start()
  await expect(requestAgentMuxControl(request, socket)).rejects.toMatchObject({ code: 'CONTROL_FAILED',
    message: 'Complete client observation exceeds the Control message budget.' })
})
