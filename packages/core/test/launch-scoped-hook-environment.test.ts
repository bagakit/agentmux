import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSpec } from '@ctxmux/sdk'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxClient } from '../src/client.js'
import { CtxmuxRunAdapter, type CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { retiredReopenFixture } from './fixtures/retired-reopen.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function inheritedScope() {
  vi.stubEnv('AGENTMUX_HOOK_LAUNCH_SCOPED', '1')
  vi.stubEnv('AGENTMUX_HOOK_NODE', '/another-core/node')
  vi.stubEnv('AGENTMUX_HOOK_RUNNER', '/another-core/agentmux-hook.js')
}

/** Keep Core and the adapter's environment merge; replace only the frozen Runtime dispatch. */
function captureStart(adapter: CtxmuxRunAdapter, run: (id: string) => CtxmuxAdapterRun) {
  const starts: RunSpec[] = []
  const startPrepared = vi.spyOn(adapter, 'startPrepared').mockImplementation(async (request, operationKey) => {
    starts.push(request)
    return { ...run(`launch-scope-run-${starts.length}`), lifecycleOperationId: operationKey }
  })
  return { starts, startPrepared }
}

function failInstallation(client: AgentMuxClient) {
  return vi.spyOn((client as any).hookInstaller, 'ensure').mockRejectedValueOnce(
    new AgentMuxError('Private plugin directory cannot be written.', 'HOOK_TARGET_UNPARSEABLE'))
}

describe('public Agent lifecycle carries launch-scoped Hook environment to Runtime', () => {
  it.each([
    { providerId: 'claude', failed: false, scope: '1' },
    { providerId: 'claude', failed: true, scope: '0' },
    { providerId: 'traex', failed: false, scope: '0' },
    { providerId: 'codex', failed: false, scope: '1' },
    { providerId: 'codex', failed: false, scope: '0', args: ['-c', 'hooks.Stop=42'] }
  ])('create $providerId with install failure=$failed reaches the adapter with scope=$scope', async ({ providerId, failed, scope, ...testCase }) => {
    const f = await rpcOwnerFixture([]); cleanup.push(f.close)
    const client = f.client, inner = client as any
    inheritedScope()
    const events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = () => ({ bindingId: 'private-scope-binding', endpoint: {
      url: 'http://127.0.0.1:0/hook', token: 'private-scope-token' }, bindRun: async () => {}, close: async () => {} })
    inner.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
    vi.spyOn(inner, 'probePreparedAgent').mockResolvedValue({ providerId, executable: providerId, installed: true,
      capabilities: client.providers.get(providerId).catalog.capabilities })
    if (failed) failInstallation(client)
    const { starts } = captureStart(inner.kernel, f.run)
    const created = await client.createAgent({ agentSessionId: 'private-scope-agent', createOperationId: 'private-scope-create',
      providerId, executorId: providerId, workspacePath: f.root, injectAgentMuxGuide: false, ...('args' in testCase ? { args: testCase.args } : {}) })
    expect(created.run).toEqual({ runId: 'launch-scope-run-1' })
    expect(starts).toHaveLength(1)
    expect(starts[0]!.env.AGENTMUX_HOOK_LAUNCH_SCOPED).toBe(scope)
    if (providerId === 'claude' || providerId === 'codex') {
      expect(starts[0]!.env.AGENTMUX_HOOK_NODE).toBe(process.execPath)
      expect(starts[0]!.env.AGENTMUX_HOOK_RUNNER).toContain('agentmux-hook.js')
      expect(starts[0]!.env.AGENTMUX_HOOK_RUNNER).not.toBe('/another-core/agentmux-hook.js')
    }
    if ('args' in testCase) expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'HOOK_LAUNCH_CONFIGURATION_UNCONFIRMED' }))
    if (failed) expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error',
      code: 'HOOK_TARGET_UNPARSEABLE', message: expect.stringContaining('The Agent continues') }))
    else expect(events.filter(event => event.type === 'agent-error' && event.code === 'HOOK_TARGET_UNPARSEABLE')).toEqual([])
  })

  it.each([false, true])('reopen preserves the original Claude identity and starts with installation failed=%s', async failed => {
    const f = await retiredReopenFixture('claude'); cleanup.push(f.close)
    inheritedScope()
    // The shared fixture skips Hook setup for unrelated reopen cases; this case exercises the owner.
    ;(f.client as any).ensureManagedHooks.mockRestore()
    if (failed) failInstallation(f.client)
    // Its ordinary fixtures replace start itself. Restore production start/prepareStart and capture
    // only the frozen dispatch, so inherited environment and explicit Run values meet at the adapter.
    f.inner.kernel.start = CtxmuxRunAdapter.prototype.start.bind(f.inner.kernel as unknown as CtxmuxRunAdapter)
    const { starts } = captureStart(f.inner.kernel as unknown as CtxmuxRunAdapter, id => f.run(id))
    const reopened = await f.client.reopenAgent(f.input)
    expect(reopened.agentSessionId).toBe(f.old.agentSessionId)
    expect(reopened.nativeHandle).toEqual(f.old.nativeHandle)
    expect(reopened.run).toEqual({ runId: 'launch-scope-run-1' })
    expect(starts).toHaveLength(1)
    expect(starts[0]!.env.AGENTMUX_HOOK_LAUNCH_SCOPED).toBe(failed ? '0' : '1')
    expect(starts[0]!.env.AGENTMUX_HOOK_RUNNER).toContain('agentmux-hook.js')
    expect(starts[0]!.env.AGENTMUX_HOOK_NODE).toBe(process.execPath)
    expect(starts[0]!.env.AGENTMUX_AGENT_SESSION_ID).toBe(f.old.agentSessionId)
    expect(starts[0]!.args).toContain('--plugin-dir')
    expect(f.stops).toEqual([])
    if (failed) expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'HOOK_TARGET_UNPARSEABLE' }))
  })
})
