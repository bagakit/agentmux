import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'

it('keeps the exact missing executable cause through original Session resume RPC and compiled CLI', async () => {
  const f = await rpcOwnerFixture(['original'], undefined, () => ({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-original' } }))
  vi.stubEnv('PATH', f.root)
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), state: { type: 'interrupted', reason: 'daemon_restart' } }))
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'resume.sock'), coreClients: f.coreClients })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const params = { target: { kind: 'agent-session' as const, agentSessionId: 'original' }, operationId: 'resume-original' }
    await expect(rpc.call('agent.resume', params)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', message: expect.stringContaining('codex') })
    const before = await f.store.readMetadata('original')
    expect(before?.continuity).toMatchObject({ operationId: params.operationId, kind: 'unavailable', errorCode: 'AGENT_NOT_FOUND', error: expect.stringContaining('codex') })
    let output = ''
    try {
      await promisify(execFile)(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + server.path,
        'agent', 'resume', '--session', 'original', '--operation-id', params.operationId],
        { timeout: 10000, env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } })
      throw new Error('Missing executable must fail the requested resume')
    } catch (error) {
      output = String((error as { stderr?: string }).stderr ?? '')
      expect(output).toContain('AGENT_NOT_FOUND')
      expect(JSON.parse(output).error.message).toBe(before!.continuity!.error!)
    }
    const after = await f.store.readMetadata('original')
    expect(after?.run).toEqual(before?.run); expect(after?.nativeHandle).toEqual(before?.nativeHandle)
    expect(after?.continuity?.operationId).toBe(params.operationId)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc?.dispose(); await server.stop(); await f.close() }
})
