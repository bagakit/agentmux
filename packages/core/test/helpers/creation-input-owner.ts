import { vi } from 'vitest'
import { rpcOwnerFixture } from './public-rpc-owner.js'
import type { AgentMuxStoredAgentSession } from '../../src/index.js'

/** Original Core metadata/input owners with an isolated deterministic Runtime transport. */
export async function creationInputOwner(postLaunch = false) {
  const h = await rpcOwnerFixture(['source', 'neighbor'])
  const inner = h.client as any, original = h.client.providers.get('codex')
  const provider = { ...original, catalog: { ...original.catalog, ...(postLaunch ? { promptDelivery: 'post-launch-only' as const } : {}) },
    prepareManagedLaunch: async (plan: any) => ({ plan }) }
  h.client.providers.replace(provider)
  const started: any[] = []
  inner.kernel.start = vi.fn(async (spec: any) => {
    const runId = 'fixture-run-' + started.length
    started.push(spec)
    return { ...h.run(runId), workspacePath: spec.cwd, program: spec.program, args: spec.args, lifecycleOperationId: spec.operationKey }
  })
  inner.kernel.list = vi.fn(async () => started.map((spec, index) => ({ ...h.run('fixture-run-' + index),
    workspacePath: spec.cwd, program: spec.program, args: spec.args, lifecycleOperationId: spec.operationKey })))
  inner.kernel.status = vi.fn(async (id: string) => {
    const index = Number(id.replace('fixture-run-', '')), spec = started[index]
    return { ...h.run(id), ...(spec ? { workspacePath: spec.cwd, program: spec.program, args: spec.args, lifecycleOperationId: spec.operationKey } : {}) }
  })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxStoredAgentSession) => session
  inner.screenEvidence.wait = vi.fn(async () => 0)
  const probe = vi.spyOn(h.client as unknown as { probePreparedAgent: typeof h.client.probeAgent }, 'probePreparedAgent').mockResolvedValue({ providerId: 'codex', executable: 'codex', installed: true, capabilities: provider.catalog.capabilities })
  const submit = vi.spyOn(inner.promptSubmission, 'submitInputPlan').mockResolvedValue(undefined)
  if (postLaunch) {
    submit.mockRestore()
    vi.spyOn(provider, 'planPromptInput').mockImplementation((prompt: string) => ({ kind: 'single-phase', data: prompt + '\r' }))
    vi.spyOn(provider as any, 'readPromptExecutionEvidence').mockResolvedValue({ state: 'idle', id: 'original-idle', sourceId: 'original-native-source' })
    vi.spyOn(provider as any, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  }
  return { ...h, inner, provider, started, probe, submit }
}
