import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { workfaceCliFixture } from './helpers/workface-cli.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'

const body = { operation: 'space.agent-order' as const, scope: 'workspace-agent-list' as const, displayWorkspaceId: 'original-workspace',
  storedOrder: [], effectiveOrder: [{ hostId: 'local', agentSessionId: 'original-session' }], changed: false, outcome: 'read' as const, save: null, issues: [] }
const base = { schemaVersion: 5, requestId: 'original-operation', operation: 'space.agent-order' }
describe('Workspace Agent order public wire', () => {
  const h = workfaceCliFixture(body)
  it('discovers accurate action help, domain help and skill without contacting the business owner', async () => {
    for (const args of [['space', 'agent-order', '--help'], ['space', '--help'], ['space', '--skill']]) {
      const count = h.seen.length, result = await h.run(args)
      expect(result.code).toBe(0); expect(result.stdout).toContain('space agent-order'); expect(h.seen).toHaveLength(count)
    }
    const action = await h.run(['space', 'agent-order', '--help'])
    expect(action.stdout).toContain('--display-workspace ID [--input FILE|-]')
    expect(action.stdout).toContain('read-only'); expect(action.stdout).toContain('storage durability')
  })
  it('validates exact scope in the actual public RPC response consumed by CLI', async () => {
    expect(await h.receipt(['space', 'agent-order', '--display-workspace', 'original-workspace'])).toMatchObject({ result: { effectiveOrder: body.effectiveOrder } })
    h.setReply({ ...body, displayWorkspaceId: 'other-workspace' })
    expect((await h.run(['space', 'agent-order', '--display-workspace', 'original-workspace'])).code).toBe(1)
    h.setReply(body)
  })
  it('reports the absent client owner as unavailable rather than an empty confirmed order', async () => {
    const service = new AgentMuxRpcService({ coreClients: () => [] })
    try { await expect(service.call('space.agent-order', { displayWorkspaceId: 'original-workspace' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' }) }
    finally { await service.dispose() }
  })
  it('strictly validates members, duplicates, unknown fields, read-only input and original target', () => {
    expect(parseSpaceControlRequest({ ...base, displayWorkspaceId: 'constructor', order: body.effectiveOrder, expectedOrder: [] })).toMatchObject({ displayWorkspaceId: 'constructor' })
    for (const fields of [
      { order: [body.effectiveOrder[0], body.effectiveOrder[0]] }, { order: [{ hostId: 'local', agentSessionId: 'self' }] },
      { order: [{ ...body.effectiveOrder[0], runId: 'wrong-identity' }] }, { expectedOrder: [] }, { order: [], focus: true }
    ]) expect(() => parseSpaceControlRequest({ ...base, displayWorkspaceId: 'original-workspace', ...fields })).toThrow()
    const { operation, ...result } = body
    expect(parseSpaceControlSuccessReceipt({ ...base, operation, ok: true, result })).toMatchObject({ result: { effectiveOrder: body.effectiveOrder } })
    expect(() => parseSpaceControlSuccessReceipt({ ...base, operation, ok: true, result: { ...result, storedOrder: [body.effectiveOrder[0], body.effectiveOrder[0]] } })).toThrow()
  })
})
