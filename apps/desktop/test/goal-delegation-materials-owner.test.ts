import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog, FileReadParams } from '@agentmux/core'
import type { GoalDelegationAuthority } from '@agentmux/core/goal-delegation'
import { openDemandStore, type DemandDelegationIntent } from '@agentmux/demand'
import { FileReadOwner } from '../src/main/file-read-owner'
import { GoalDelegationOwner } from '../src/main/goal-delegation-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const digest = (content: string) => 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex')
async function fixture(readAvailable = true) {
  const root = await mkdtemp(join(tmpdir(), 'amux-delegation-materials-owner-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'mote'))
  const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', path: root, name: 'Original', kind: 'folder' }
  const zone = { zoneId: 'original-zone', workspaceId: workspace.id, hostId: workspace.hostId, directoryPath: join(root, 'mote'), kind: 'temporary' }
  const catalog = { zones: [zone], bindings: [{ zoneId: zone.zoneId, spaceId: 'original-space' }] } as unknown as AgentMuxSpaceCatalog
  const files = new WorkspaceFiles(id => ({ id, kind: 'local', label: 'Local', run: vi.fn(), exposeLoopbackPort: async (port: number) => port, dispose: async () => {} }))
  cleanup.push(() => files.dispose())
  const originalFiles = new FileReadOwner({ catalog: async () => catalog, workspace: id => id === workspace.id ? workspace : undefined, files })
  const read = vi.fn((input: FileReadParams) => originalFiles.read(input))
  const demandsRoot = join(root, 'goals'), demands = openDemandStore({ root: demandsRoot })
  await demands.create({ id: 'original-goal', title: 'Original Goal', description: 'Preserved original user request', status: 'in_progress',
    assigneeSessionIds: ['original-owner', 'original-worker'], supervisorSessionId: 'original-owner' })
  await demands.proposeAlignment('original-goal', { summary: 'Original task scope', criteria: [{ id: 'AC-source', text: 'Retain original source input' }], openQuestions: [] })
  const runtime = { agentCreation: vi.fn(async (_hostId: string, agentSessionId: string) => ({ agentSessionId,
    run: { runId: agentSessionId + '-run' } } as never)) }
  const owner = new GoalDelegationOwner(demands, runtime, readAvailable ? read : undefined)
  const target: FileReadParams = { zoneId: zone.zoneId, spaceId: 'original-space', path: 'source.md',
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: root } }
  const intent: DemandDelegationIntent = { operationId: 'original-operation', sourceMessageId: 'original-message', hostId: 'local',
    ownerAgentSessionId: 'original-owner', workerAgentSessionId: 'original-worker', ownerRunId: 'original-owner-run', workerRunId: 'original-worker-run',
    threadId: 'original-thread', text: ' Original task request\nwith whitespace ', alignmentRevision: 1, criterionIds: ['AC-source'],
    context: [{ kind: 'skill', source: 'original-skill', revision: null, scope: 'provider-original', availability: 'available' }] }
  const authority: GoalDelegationAuthority = { actor: { kind: 'agent', id: intent.ownerAgentSessionId }, hostId: intent.hostId, runId: intent.ownerRunId }
  await writeFile(join(root, 'mote/source.md'), 'Original selected source 中文\n' + 'x'.repeat(6200))
  const input = { goalId: 'original-goal', intent, materials: [target] }
  return { root, demandsRoot, demands, runtime, owner, read, target, intent, authority, input }
}

it('Main reads original Files once, freezes the actual task text and reuses it after source changes and owner reload', async () => {
  const f = await fixture(), sourceContent = await readFile(join(f.root, 'mote/source.md'), 'utf8')
  const result = await f.owner.call('goal.delegation.prepare', f.input, {}, f.authority)
  expect(result.delegations).toHaveLength(1)
  const prepared = result.delegations[0]!
  expect(prepared.requestText).toBe(f.intent.text)
  expect(prepared.text.startsWith(f.intent.text + '\n\nTask materials')).toBe(true)
  expect(JSON.parse(prepared.text.split('\n[AgentMux delegation]\n')[1]!)).toMatchObject({ schema: 'agentmux.goal-delegation.v1',
    goalId: f.input.goalId, operationId: f.intent.operationId, sourceMessageId: f.intent.sourceMessageId, threadId: f.intent.threadId,
    ownerAgentSessionId: f.intent.ownerAgentSessionId, workerAgentSessionId: f.intent.workerAgentSessionId, criterionIds: f.intent.criterionIds })
  const sourceLine = prepared.text.split('\n\n').find(line => line.startsWith('{"target":'))
  expect(sourceLine).toBeDefined()
  const actualSource = JSON.parse(sourceLine!)
  expect(actualSource).toMatchObject({ target: f.target, resource: { ...f.target.expectedResource,
    zoneId: f.target.zoneId, zonePath: join(f.root, 'mote'), path: 'mote/source.md' }, status: 'read',
    path: 'mote/source.md', revision: digest(sourceContent), contentHash: digest(sourceContent),
    excerpt: sourceContent.slice(0, 6000), excerpted: true })
  expect(prepared.context).toEqual([...f.intent.context!, { kind: 'file', source: 'mote/source.md',
    revision: digest(sourceContent), scope: JSON.stringify(f.target), availability: 'excerpt' }])
  expect(f.read.mock.calls.map(([input]) => input)).toEqual([f.target])
  expect(f.runtime.agentCreation.mock.calls).toEqual([['local', 'original-owner'], ['local', 'original-worker']])
  const snapshot = await f.demands.snapshot()
  await writeFile(join(f.root, 'mote/source.md'), 'Later source must not silently replace original input')
  await writeFile(join(f.root, 'unrelated.md'), 'Unrelated file is not a source')
  const reloaded = openDemandStore({ root: f.demandsRoot })
  const resumedOwner = new GoalDelegationOwner(reloaded, f.runtime, f.read)
  const retried = await resumedOwner.call('goal.delegation.prepare', f.input, {}, f.authority)
  expect(retried.delegations).toEqual(result.delegations)
  expect(await reloaded.snapshot()).toEqual(snapshot)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.runtime.agentCreation).toHaveBeenCalledTimes(2)
  expect((await reloaded.get(f.input.goalId))!).toMatchObject({ description: 'Preserved original user request',
    supervisorSessionId: 'original-owner', status: 'in_progress', alignment: { confirmedAt: null } })
  if (process.env.AGENTMUX_T004_EVIDENCE_DIR) {
    const directory = process.env.AGENTMUX_T004_EVIDENCE_DIR
    await mkdir(directory, { recursive: true })
    const implementation = await readFile(resolve(import.meta.dirname, '../src/main/goal-delegation-materials.ts'), 'utf8')
    await writeFile(join(directory, 'consumer-receipt.json'), JSON.stringify({ status: 'passed',
      implementationHash: createHash('sha256').update(implementation).digest('hex'),
      originalOperationId: prepared.operationId, originalMessageId: prepared.sourceMessageId,
      originalGoalId: f.input.goalId, originalOwner: prepared.ownerAgentSessionId, originalWorker: prepared.workerAgentSessionId,
      actualInput: prepared.text, actualInputStage: 'original-Goal-frozen-intent',
      sourceEvidence: actualSource, requestText: prepared.requestText, context: prepared.context,
      sourceReads: f.read.mock.calls.map(([input]) => input),
      retryAfterOriginalFileChange: { sameFrozenInput: retried.delegations[0]!.text === prepared.text, sourceReadCount: f.read.mock.calls.length },
      preservedHumanBoundary: { confirmedAt: null, noAcceptedResult: true },
      limitations: 'Uses actual Main, Demand and Files owners in isolated qualification. Provider adoption and Runtime submission/restart are verified separately by T005.' }, null, 2) + '\n')
  }
})

it('same File target in another property order retries, while changed target or declared context refuses only that operation', async () => {
  const f = await fixture()
  const result = await f.owner.call('goal.delegation.prepare', f.input, {}, f.authority)
  const target: FileReadParams = { path: f.target.path, expectedResource: { workspacePath: f.target.expectedResource.workspacePath,
    workspaceId: f.target.expectedResource.workspaceId, hostId: f.target.expectedResource.hostId }, spaceId: f.target.spaceId!,
    zoneId: f.target.zoneId }
  expect((await f.owner.call('goal.delegation.prepare', { ...f.input, materials: [target] }, {}, f.authority)).delegations).toEqual(result.delegations)
  const snapshot = await f.demands.snapshot()
  await expect(f.owner.call('goal.delegation.prepare', { ...f.input, materials: [{ ...f.target, zoneId: 'another-mote' }] }, {}, f.authority))
    .rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  await expect(f.owner.call('goal.delegation.prepare', { ...f.input, intent: { ...f.intent, context: [] } }, {}, f.authority))
    .rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(await f.demands.snapshot()).toEqual(snapshot)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect((await f.owner.call('goal.delegation.prepare', f.input, {}, f.authority)).delegations).toEqual(result.delegations)
})

it('a missing Files observation port saves unknown provenance and keeps the original Goal and task usable', async () => {
  const f = await fixture(false)
  const result = await f.owner.call('goal.delegation.prepare', f.input, {}, f.authority)
  expect(result.delegations).toHaveLength(1)
  expect(result.delegations[0]).toMatchObject({ requestText: f.intent.text,
    context: [...f.intent.context!, { kind: 'file', source: f.target.path, revision: null, scope: JSON.stringify(f.target), availability: 'unknown' }] })
  expect(result.delegations[0]!.text).toContain('this source is unknown and the task is retained')
  expect(f.read).not.toHaveBeenCalled()
  expect((await f.demands.get(f.input.goalId))!).toMatchObject({ status: 'in_progress', supervisorSessionId: 'original-owner' })
})
