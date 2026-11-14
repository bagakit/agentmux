import { defineRun } from '@ctxmux/sdk'
import { vi } from 'vitest'
import { rpcOwnerFixture } from './public-rpc-owner.js'
import type { AgentMuxStoredAgentSession } from '../../src/index.js'
import type { AgentMuxClientOptions } from '../../src/client-contract.js'

/** Original Core metadata/input owners with an isolated deterministic Runtime transport. */
export async function creationInputOwner(postLaunch = false, clientOptions?: (root: string) => Omit<AgentMuxClientOptions, 'store'>) {
  const h = await rpcOwnerFixture(['source', 'neighbor'], undefined, undefined, clientOptions)
  const inner = h.client as any, original = h.client.providers.get('codex')
  const contribution = { ...original }
  if (postLaunch) {
    contribution.hook = { rules: [] }
    delete contribution.terminalHandshake
    delete contribution.terminalPromptRender
    delete contribution.readInputInitialization
    delete contribution.prepareNativeInput
    delete contribution.observeTerminalFrontend
    delete contribution.buildForkLaunch
  }
  const provider = { ...contribution, catalog: { ...original.catalog, ...(postLaunch ? {
    promptDelivery: 'post-launch-only' as const,
    capabilities: { terminal: true as const, timeline: 'unavailable' as const, permission: 'none' as const, providerResume: false, replyCorrelation: 'none' as const },
    hookStrategy: { kind: 'none' as const }, resumeStrategy: { kind: 'none' as const }
  } : {}) }, prepareManagedLaunch: async (plan: any) => ({ plan }) }
  h.client.providers.replace(provider)
  inner.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'original-fixture-native', instanceId: 'original-fixture-instance', protocolVersion: 1, buildIdentity: 'fixture' })
  const started: any[] = []
  inner.kernel.prepareStart = ({ program, args, cwd, env, cols, rows }: any) => defineRun(program, { args, cwd, env, initialSize: { cols: cols ?? 80, rows: rows ?? 24 } })
  inner.kernel.startPrepared = (request: any, operationKey: string) => inner.kernel.start({ ...request, operationKey })
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
  inner.kernel.inspectPreparedStart = async (_request: unknown, operationKey: string) => (await inner.kernel.list()).find((run: any) => run.lifecycleOperationId === operationKey) ?? null
  inner.kernel.inspectRetainedStart = async (key: string) => {
    const spec=started.find(spec=>spec.operationKey===key)
    if(!spec)return null
    const {operationKey: _key,...request}=spec
    return {runtime:inner.kernel.creationRuntimeIdentity(),prepared:{createOperationId:key,workspacePath:spec.cwd,launch:JSON.stringify({createOperationId:key,request})},
      run:await inner.kernel.inspectPreparedStart(request,key)}
  }
  inner.kernel.observePreparedStartRetirement = async () => ({ outcome: 'unknown' })
  inner.kernel.retirePreparedStart = async (_request: unknown, operationKey: string, runtime: unknown) => {
    const run = (await inner.kernel.list()).find((run: any) => run.lifecycleOperationId === operationKey)
    return run ? { outcome: 'retained', run, runtime } : { outcome: 'retired', runtime }
  }
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = (_sid: string, _provider: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
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
