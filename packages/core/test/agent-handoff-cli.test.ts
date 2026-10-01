import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/control-host.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { privateRpcCorePort } from './helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

describe('compiled object handoff delegates to the original authenticated Core owner', () => {
  it('declares communication ownership without sending text, returns Core facts and rejects forged carriers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oh-'))
    const storePath = join(root, 'sessions.json'), queuePath = join(root, 'messages.ndjson')
    const capability = issueAgentCapability(), store = new AgentMuxFileAgentSessionStore(storePath)
    for (const agentSessionId of ['sender', 'recipient']) await store.compareAndSwap(null, {
      kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
      run: { runId: `original-${agentSessionId}` }, retiredRuns: [], hookBindingId: `hook-${agentSessionId}`,
      hookToken: `synthetic-${agentSessionId}`, createdAt: 1, updatedAt: 1,
      ...(agentSessionId === 'sender' ? { capabilityHash: hashAgentCapability(capability) } : {})
    })
    const core = await privateRpcCorePort(storePath, queuePath)
    const handoff = vi.spyOn(core.client, 'handOff')
    const execute = vi.fn()
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients, execute })
    await server.start()
    const env = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: 'sender', AGENTMUX_AGENT_CAPABILITY: capability })
    const args = ['agent', 'handoff', '--to-session', 'recipient', '--task', '--help']
    try {
      const body = await runCompiledObjectCli(args, env)
      expect(body.code, body.stderr).toBe(0)
      expect(JSON.parse(body.stdout)).toEqual({ ok: true, operation: 'agent.handoff', result: {
        taskId: '--help', ownerAgentSessionId: 'recipient', originAwaits: false, at: expect.any(Number)
      } })
      expect(handoff).toHaveBeenCalledExactlyOnceWith({ capability, callerAgentSessionId: 'sender', toAgentSessionId: 'recipient', taskId: '--help' })
      expect(execute).not.toHaveBeenCalled()
      for (const invalid of [
        [...args, '--text', 'not a handoff'], ['agent', 'handoff', '--to-session', 'self', '--task', 'T'],
        ['agent', 'handoff', '--to-session', 'recipient'], [...args, '--task', 'duplicate']
      ]) {
        const failure = await runCompiledObjectCli(invalid, env)
        expect(failure.code).toBe(1)
        expect(JSON.parse(failure.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
      }
      const forged = await runCompiledObjectCli(args, { ...env, AGENTMUX_AGENT_CAPABILITY: 'forged' })
      expect(forged.code).toBe(1)
      expect(JSON.parse(forged.stderr).error.code).toBe('AGENT_CAPABILITY_INVALID')
      const human = await runCompiledObjectCli(args, objectCliEnvironment(root))
      expect(human.code).toBe(1)
      expect(JSON.parse(human.stderr).error.code).toBe('MANAGED_AGENT_CONTEXT_REQUIRED')
      expect(handoff).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks(); await server.stop(); await core.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
