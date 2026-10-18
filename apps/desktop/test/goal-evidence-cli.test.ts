// @vitest-environment happy-dom
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { goalEvidenceSource } from './helpers/goal-evidence-source'
import { runCompiledObjectCli, objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AppConfig } from '../src/shared/contracts'
const initial = useAppStore.getState(), cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { useAppStore.setState(initial); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

it('takes an actual CLI Files receipt into goal update and restores the same typed evidence through goal inspect', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve(import.meta.dirname, '../../../packages/core/bin/amux'))
  const source = await goalEvidenceSource(); cleanup.push(source.dispose)
  const owner = openDemandStore({ root: join(source.root, 'goals') })
  await owner.create({ id: 'original-goal', title: 'Original', status: 'in_progress', sessionIds: [] })
  await owner.proposeAlignment('original-goal', { summary: 'Original agreement', criteria: [{ id: 'c', text: 'Actual outcome' }], openQuestions: [] })
  await owner.proposeGrounding('original-goal', { alignmentRevision: 1, summary: 'Original report', checks: [{ criterionId: 'c', outcome: 'met', evidence: ['Original citation'], note: '' }] })
  useAppStore.setState({ ...initial, config: { ...initial.config, workspaces: source.workspaces, hosts: [], executors: {}, appearance: {} } as AppConfig, sessions: [], demands: {} })
  vi.spyOn(api.demands, 'list').mockImplementation(() => owner.list())
  vi.spyOn(api.demands, 'update').mockImplementation((id, patch, operationId, expectedUpdatedAt) => owner.update(id, patch, { operationId, expectedUpdatedAt }))
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  const server = new AgentMuxControlServer({ socketPath: join(source.root, 'control.sock'), coreClients: () => [], files: source.owner,
    execute: request => useAppStore.getState().executeControl(request) })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(source.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
  const run = async (...args: string[]) => { const response = await runCompiledObjectCli(args, env); expect(response.code, response.stderr || response.stdout).toBe(0); return JSON.parse(response.stdout).result }
  const target = source.target, original = await run('file', 'read', '--zone', target.zoneId, '--path', target.path, '--host', target.expectedResource.hostId, '--workspace', target.expectedResource.workspaceId, '--workspace-path', target.expectedResource.workspacePath)
  expect(original.result.status).toBe('read'); expect(original.result.document.content).toBe('ORIGINAL worktree evidence')
  const before = (await run('goal', 'inspect', '--goal', 'original-goal')).goal
  const evidence = { kind: 'file', resource: original.resource, revision: original.result.document.revision }
  const proposal = { alignmentRevision: before.grounding.alignmentRevision, summary: before.grounding.summary, checks: before.grounding.checks }
  proposal.checks[0].evidence.push(evidence)
  const saved = await run('goal', 'update', '--goal', 'original-goal', '--expected-updated-at', String(before.updatedAt), '--grounding', JSON.stringify(proposal))
  expect(saved.goal.grounding.checks[0].evidence).toEqual(['Original citation', evidence])
  expect((await run('goal', 'inspect', '--goal', 'original-goal')).goal.grounding).toEqual(saved.goal.grounding)
  expect((await openDemandStore({ root: join(source.root, 'goals') }).get('original-goal'))!.grounding!.checks[0]!.evidence).toEqual(['Original citation', evidence])
  const rejected = await runCompiledObjectCli(['goal', 'update', '--goal', 'original-goal', '--grounding', JSON.stringify({ ...proposal, checks: [{ ...proposal.checks[0], evidence: [{ ...evidence, resource: { ...evidence.resource, path: '../other/result.log' } }] }] })], env)
  expect(rejected.code).toBe(1)
  expect((await owner.get('original-goal'))!.grounding).toEqual(saved.goal.grounding)
}, 30_000)
