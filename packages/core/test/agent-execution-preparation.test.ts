import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
it('requires the original frontend Provider bound-launch contribution before any helper preparation or Native connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-frontend-required-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', root); vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const { prepareToolExecutionLaunch: _absent, ...base } = new AgentProviderRegistry().get('claude')
  const prepareExecutionHelper = vi.fn(async () => ({ command: process.execPath, args: [], env: {} }))
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [{ ...base, prepareExecutionHelper }] }); cleanup.push(() => client.dispose())
  vi.spyOn(client, 'prepareTerminal').mockResolvedValue({ createOperationId: 'original-frontend', workspacePath: root, launch: JSON.stringify({ createOperationId: 'original-frontend', request: { program: process.execPath, args: [], cwd: root, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: 'original-frontend' }, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } }) })
  await expect(client.prepareAgentExecutionHelper({ role: 'frontend', providerId: 'claude', bindingId: 'original-binding', agentSessionId: 'original-agent', createOperationId: 'original-frontend', workspacePath: root,
    toolExecution: { bindingId: 'original-binding', resourceHostId: 'resource', resourceRuntimeId: 'original-resource', workspacePath: root } })).rejects.toMatchObject({ code: 'EXECUTION_PROVIDER_UNSUPPORTED' })
  expect(prepareExecutionHelper).not.toHaveBeenCalled()
})
