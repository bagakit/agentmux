import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openDemandStore } from '../src/demand-store.js'
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { parseDemandDispatch, parseDemandDispatchIntent, sameDemandDispatchIntent, type DemandQualifiedDispatchIntent, type DemandQualifiedDispatchReceipt } from '../src/dispatch.js'
import { demandExecutionReferences, demandExecutionKey } from '../src/responsibility.js'
import { demandAgentReferenceKey, projectDemandRelations } from '../src/relations.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const intent = (): DemandQualifiedDispatchIntent => ({ operationId: 'original-OP', target: { kind: 'space-member',
  source: { runtimeId: 'B', spaceId: 'Space', regionId: 'Region', admission: { kind: 'creation', operationId: 'C' } },
  execution: { runtimeId: 'D', agentSessionId: 'original-SID' } }, runId: 'original-Run', execution: 'finite', prompt: 'Original Goal body', agentMuxNote: '' })
const receipt = (): DemandQualifiedDispatchReceipt => ({ kind: 'core-input', inputKey: { kind: 'prompt', agentSessionId: 'original-SID', expectedRun: { runId: 'original-Run' }, submissionId: 'original-OP' }, outcome: 'admitted', observedAt: 2 })

it('keeps the original legacy dispatch bytes while qualified receipts require the exact original typed input', () => {
  const legacy = { operationId: 'legacy-OP', agentSessionId: 'legacy-SID', hostId: 'legacy-host', runId: 'legacy-Run', execution: 'finite', prompt: 'Legacy input' }
  expect(JSON.stringify(parseDemandDispatchIntent(legacy))).toBe(JSON.stringify(legacy))
  const original = intent(), confirmed = { ...original, stage: 'confirmed', preparedAt: 1, submittedAt: 2, receipt: receipt() }
  expect(parseDemandDispatch(confirmed)).toEqual(confirmed)
  expect(parseDemandDispatchIntent(original)).toEqual(original)
  for (const changed of [{ ...original, hostId: 'fake-host' }, { ...original, agentSessionId: 'fake-SID' }, { ...original, execution: 'continue' }, { ...original, target: 'raw-SID' }]) expect(() => parseDemandDispatchIntent(changed)).toThrow()
  for (const inputKey of [{ ...receipt().inputKey, agentSessionId: 'another-SID' }, { ...receipt().inputKey, submissionId: 'another-OP' }, { ...receipt().inputKey, expectedRun: { runId: 'another-Run' } }]) expect(() => parseDemandDispatch({ ...confirmed, receipt: { ...receipt(), inputKey } })).toThrow('another original input')
  expect(() => parseDemandDispatch({ ...confirmed, receipt: { kind: 'core-prompt', itemId: 'prompt:original-OP', createdAt: 2 } })).toThrow()
  const { agentMuxNote: _note, ...withoutNote } = original
  expect(sameDemandDispatchIntent(original, withoutNote)).toBe(false)
})

it('the original writer arbitrates concurrent producers and retains the frozen body, note, source and operation through a separate process read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-qualified-dispatch-')); directories.push(root)
  const store = openDemandStore({ root }), original = intent()
  await seedStoredDemand(store, { id: 'original-goal', title: 'Original Goal', sessionIds: [original.target], assigneeSessionIds: [original.target] })
  const races = await Promise.allSettled([store.prepareDispatch('original-goal', original), store.prepareDispatch('original-goal', { ...original, prompt: 'Another producer body' })])
  expect(races.map(row => row.status).sort()).toEqual(['fulfilled', 'rejected'])
  const frozen = await store.inspectDispatch('original-goal', original.operationId)
  expect(frozen).toMatchObject({ ...original, stage: 'prepared' })
  await expect(store.prepareDispatch('original-goal', { ...original, agentMuxNote: 'Another producer note' })).rejects.toThrow('another Goal, Session, Run or input')
  await expect(store.prepareDispatch('original-goal', { ...original, target: { ...original.target, execution: { ...original.target.execution, runtimeId: 'E' } } })).rejects.toThrow()
  await store.recordDispatchPhase('original-goal', original.operationId, { stage: 'submitted' })
  const file = join(root, 'store.json'), before = await stat(file), bytes = await readFile(file)
  const compiled = join(root, 'compiled')
  await promisify(execFile)(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'packages/demand/tsconfig.build.json', '--outDir', compiled, '--declaration', 'false', '--sourceMap', 'false'], { timeout: 30000 })
  await writeFile(join(compiled, 'package.json'), JSON.stringify({ type: 'module' }))
  await symlink(resolve('packages/demand/node_modules'), join(compiled, 'node_modules'))
  const script = join(root, 'read-original.mjs')
  await writeFile(script, `import {openDemandStore} from ${JSON.stringify('file://' + join(compiled, 'src/demand-store.js'))};console.log(JSON.stringify({pid:process.pid,dispatch:await openDemandStore({root:${JSON.stringify(root)}}).inspectDispatch('original-goal','original-OP')}));`)
  const child = await promisify(execFile)(process.execPath, [script], { timeout: 10000 }), restored = JSON.parse(child.stdout)
  expect(restored.pid).not.toBe(process.pid); expect(restored.dispatch).toEqual(await store.inspectDispatch('original-goal', original.operationId))
  expect(restored.dispatch).toMatchObject({ ...original, stage: 'submitted' })
  expect(restored.dispatch).not.toHaveProperty('hostId'); expect(restored.dispatch).not.toHaveProperty('agentSessionId')
  expect(await readFile(file)).toEqual(bytes); const after = await stat(file); expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
  await store.recordDispatchPhase('original-goal', original.operationId, { stage: 'confirmed', receipt: receipt() })
  await store.recordDispatchPhase('original-goal', original.operationId, { stage: 'unknown', issue: 'Late observation failed' })
  expect(await store.inspectDispatch('original-goal', original.operationId)).toMatchObject({ stage: 'confirmed', receipt: receipt() })
})

it('responsibility and relationship projections keep qualified execution identity instead of creating a Host or bare Session alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-qualified-role-')); directories.push(root)
  const store = openDemandStore({ root }), original = intent()
  await seedStoredDemand(store, { id: 'goal', title: 'Original Goal', sessionIds: [original.target] })
  const saved = (await store.prepareDispatch('goal', original)).demand
  const references = demandExecutionReferences(saved)
  expect(references).toEqual([{ kind: 'start', operationId: original.operationId, target: original.target, runId: original.runId }])
  expect(demandExecutionKey(references[0]!)).not.toBe(JSON.stringify(['start', original.operationId, 'D', 'original-SID', original.runId]))
  const relations = projectDemandRelations([saved])
  expect(relations.qualified.size).toBe(0); expect(relations.unqualified.size).toBe(0)
  expect(relations.sourceQualified.get(demandAgentReferenceKey(original.target))?.relations[0]?.roles).toContainEqual({ kind: 'execution', source: { kind: 'dispatch', id: original.operationId } })
})
