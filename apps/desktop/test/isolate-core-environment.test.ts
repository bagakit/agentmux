import { fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'

afterEach(() => vi.unstubAllEnvs())

it('isolates every Core path owner and removes inherited Runtime credentials before creating a controlled client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-fixture-isolation-'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', _tailFixturePath("not-accessed/live-state"))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', _tailFixturePath("not-accessed/live-sessions.json"))
  vi.stubEnv('AGENTMUX_AGENT_CAPABILITY', 'not-a-live-credential')
  vi.stubEnv('AGENTMUX_RPC_ENDPOINT', "unix:" + _tailFixturePath("not-accessed/live.sock"))
  vi.stubEnv('CTXMUX_SOCKET', _tailFixturePath("not-accessed/live-runtime.sock"))
  isolateCoreFixtureEnvironment(directory)
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  try {
    expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(join(directory, 'runtime'))
    expect(process.env.AGENTMUX_STATE_DIRECTORY).toBe(join(directory, 'state'))
    expect(process.env.AGENTMUX_AGENT_SESSION_STORE).toBe(join(directory, 'agent-sessions.json'))
    expect(client.agentMessageQueuePath()).toBe(join(directory, 'messages.ndjson'))
    expect(Reflect.get(client, 'deliveryAttempts').directory).toBe(join(directory, 'state', 'delivery-attempts'))
    expect(Reflect.get(client, 'controlSocketPath')).toBe(join(directory, 'runtime', 'control.sock'))
    expect(process.env.AGENTMUX_AGENT_CAPABILITY).toBeUndefined()
    expect(process.env.AGENTMUX_RPC_ENDPOINT).toBeUndefined()
    expect(process.env.CTXMUX_SOCKET).toBeUndefined()
    expect(Reflect.get(client, 'kernel').isConnected()).toBe(false)
  } finally { await client.dispose(); await rm(directory, { recursive: true, force: true }) }
})
