import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { connectHostedAgentMux as SourceConnectHosted } from '../src/hosted-client.js'
import { encodeHostedValue, decodeHostedValue, hostedTransfer } from '../src/hosted-value.js'
import type { AgentMuxHostedBootstrap, AgentMuxHostedClient, AgentMuxHostedInvocation, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
const connectHostedAgentMux: typeof SourceConnectHosted = process.env.AGENTMUX_TEST_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CLIENT_ENTRY)).connectHostedAgentMux : SourceConnectHosted


describe('Hosted ordinary record identity', () => {
  it('preserves marker-shaped env dictionaries in the actual typed createAgent invocation at its rejecting receiver', async () => {
    const identity: AgentMuxHostedBootstrap['identity'] = { hostId: 'local', instanceId: 'private-daemon', processId: 123,
      buildIdentity: 'private-fixture', protocolVersion: 1, ownership: 'owned' }
    const initial: AgentMuxHostedBootstrap = { identity, owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 1, processId: 123, availability: 'connected', ctxmux: identity }, storePath: fixturePath("private-store/sessions.json"),
      hostProcessId: 123, catalog: [], sessions: [], messageQueuePath: fixturePath("private-store/messages.ndjson") }
        const received: Array<Parameters<AgentMuxHostedClient['createAgent']>[0]> = []
    const rejectCreate = (input: Parameters<AgentMuxHostedClient['createAgent']>[0]): never => {
      received.push(input)
      throw new AgentMuxError('The private typed receiver stops before launching any Agent.', 'AGENT_EXECUTOR_UNAVAILABLE')
    }
    const port = {
      call: async (method: string, params: unknown) => {
        if (method === 'runtime.owner.identity') return { owner: initial.owner }
        if (method === 'runtime.bootstrap') return initial
        if (method === 'runtime.release-consumer') return { released: true }
        if (method !== 'runtime.invoke') throw new Error(`Unexpected port method: ${method}`)
        const invocation = decodeHostedValue(JSON.parse(JSON.stringify((params as { invocation: unknown }).invocation))) as AgentMuxHostedInvocation
        if (invocation.method === 'runtimeProjection') return { value: encodeHostedValue({ hostId: 'local', subjects: [] }) }
        if (invocation.method === 'createAgent') rejectCreate(invocation.args[0])
        throw new Error(`Unexpected business method: ${invocation.method}`)
      },
      subscribe: async (_method: string, _params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
        handlers.onInitial({ owner: initial.owner, transferId: 'bootstrap-original' });
        for (const data of hostedTransfer({ kind: 'initial', value: initial }, 'bootstrap-original')) handlers.onEvent({ type: 'snapshot', data }); return { dispose: async () => {} }
      }
    } as AgentMuxHostedRpcPort
    const client = await connectHostedAgentMux({ rpc: port })
    const dictionaries: Array<Readonly<Record<string, string>>> = [
      { $agentmuxValue: 'undefined' }, { $agentmuxValue: 'bytes', data: 'AP8=' },
      { $agentmuxValue: 'record', entries: 'ordinary environment value' }
    ]
    const inputs: Array<Parameters<AgentMuxHostedClient['createAgent']>[0]> = dictionaries.map(env =>
      ({ providerId: 'codex', executorId: 'codex', workspacePath: fixturePath("private-workspace"), injectAgentMuxGuide: false, env }))
    try {
      for (const input of inputs) await expect(client.createAgent(input)).rejects.toMatchObject({ code: 'AGENT_EXECUTOR_UNAVAILABLE' })
      expect(received).toEqual(inputs)
    } finally { await client.dispose() }
  })

  it('roundtrips nested ordinary records, actual bytes and undefined tuple slots without recursively interpreting returned data as markers', () => {
    const value = { ordinary: [
      { $agentmuxValue: 'undefined' }, { $agentmuxValue: 'bytes', data: 'AP8=' },
      { $agentmuxValue: 'record', entries: [['nested', { $agentmuxValue: 'undefined' }]] },
      { $agentmuxValue: 'unknown', signal: 'ordinary field' }
    ], args: [undefined, Uint8Array.of(0, 128, 255), undefined, 'refresh-operation-original'],
    replay: [{ startByte: 17, endByte: 20, dataBytes: Uint8Array.of(0, 128, 255) }] }
    expect(decodeHostedValue(JSON.parse(JSON.stringify(encodeHostedValue(value))))).toEqual(value)
  })
})
