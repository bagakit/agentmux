import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import type { Demand } from '../src/demand-types.js'
import { openDemandStore } from '../src/demand-store.js'
import { parseDemandAgentReference, parseDemandAgentReferences, demandAgentReferenceKey, projectDemandRelations, type DemandSpaceMemberReference } from '../src/relations.js'

const ref = (runtimeId = 'executor-D', operationId = 'creation-C'): DemandSpaceMemberReference => ({ kind: 'space-member',
  source: { runtimeId: 'source-B', spaceId: 'space-original', regionId: 'region-original', admission: { kind: 'creation', operationId } },
  execution: { runtimeId, agentSessionId: 'same-SID' } })
let root: string, compiled: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentmux-qualified-goal-'))
  compiled = join(root, 'compiled')
  await promisify(execFile)(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'packages/demand/tsconfig.build.json',
    '--outDir', compiled, '--declaration', 'false', '--sourceMap', 'false'], { cwd: resolve('.'), timeout: 30000 })
  await writeFile(join(compiled, 'package.json'), JSON.stringify({ type: 'module' }))
  await symlink(resolve('packages/demand/node_modules'), join(compiled, 'node_modules'))
}, 40000)
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
function cli(args: string[]) {
  return new Promise<{ pid: number; code: number | null; value: { demand: Demand }; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(compiled, 'bin/agentmux-demand.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', bytes => { out += String(bytes) }); child.stderr.on('data', bytes => { err += String(bytes) })
    child.on('error', reject); child.on('close', code => {
      try { resolve({ pid: child.pid!, code, value: JSON.parse(out.trim() || err.trim()), stderr: err }) } catch (error) { reject(new Error(`Private CLI exited ${code}: ${out || err}`, { cause: error })) }
    })
  })
}

it('keeps raw bytes distinct from exact source/admission/execution identities and refuses unknown fields', () => {
  const a = ref(), b = ref('executor-E'), c = ref('executor-D', 'other-C')
  expect(new Set(['same-SID', a, b, c].map(demandAgentReferenceKey)).size).toBe(4)
  expect(parseDemandAgentReference(JSON.stringify(a))).toBe(JSON.stringify(a)) // not an encoded qualified identity
  expect(parseDemandAgentReference(a)).toEqual(a)
  expect(() => parseDemandAgentReferences([a, structuredClone(a)])).toThrow('duplicates')
  expect(() => parseDemandAgentReference({ ...a, route: 'authority' })).toThrow()
  expect(() => parseDemandAgentReference({ ...a, source: { ...a.source, admission: { kind: 'creation', operationId: '' } } })).toThrow()
  expect(() => parseDemandAgentReference({ ...a, execution: { ...a.execution, runId: 'not-a-relation' } })).toThrow()
})

it('uses the original snapshot/CAS and semantic role subsets without dispatch or inferred qualification', async () => {
  const store = openDemandStore({ root: join(root, 'role-store') }), a = ref(), b = ref('executor-E')
  const creating = store.create({ id: 'goal-original', title: 'Original Goal', sessionIds: ['legacy bytes', a],
    assigneeSessionIds: [structuredClone(a), b], supervisorSessionId: structuredClone(a) })
  const outcome = await creating.then(value => ({ value, error: null }), error => ({ value: null, error }))
  expect(outcome).toMatchObject({ value: { demand: { id: 'goal-original', supervisorSessionId: a } }, error: null })
  const created = outcome.value!
  expect(created.demand.sessionIds).toEqual(['legacy bytes', a, b])
  expect(created.demand.dispatches).toBeUndefined(); expect(created.demand.delegations).toBeUndefined()
  await expect(store.update('goal-original', { supervisorSessionId: ref('wrong-runtime') })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  const before = await store.get('goal-original')
  await store.update('goal-original', { description: 'ordinary offline edit' }, { expectedUpdatedAt: before!.updatedAt })
  await expect(store.update('goal-original', { title: 'stale edit' }, { expectedUpdatedAt: before!.updatedAt })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  const after = await openDemandStore({ root: store.root }).get('goal-original')
  expect(after!.sessionIds).toEqual(created.demand.sessionIds)
  expect(after!.assigneeSessionIds).toEqual([a, b]); expect(after!.supervisorSessionId).toEqual(a)
  expect(after!.description).toBe('ordinary offline edit')
  expect(after!.dispatches ?? []).toEqual([])
})

it('projects exact source-qualified relations without inserting them into bare or Host identity maps', () => {
  const a = ref(), b = ref('executor-E'), result = projectDemandRelations([{ id: 'g', title: 'G', status: 'todo',
    sessionIds: ['same-SID', a, b], assigneeSessionIds: [a, b], supervisorSessionId: structuredClone(a) }])
  expect(result.qualified.size).toBe(0); expect(result.unqualified.size).toBe(1)
  expect(result.sourceQualified.size).toBe(2)
  expect(result.sourceQualified.get(demandAgentReferenceKey(a))?.relations[0]!.roles.map(role => role.kind)).toEqual(['related', 'assignee', 'supervisor'])
  expect(result.sourceQualified.get(demandAgentReferenceKey(b))?.relations[0]!.roles.map(role => role.kind)).toEqual(['related', 'assignee'])
})

it('the real compiled filesystem CLI preserves mixed references and original file across independent processes', async () => {
  const dir = join(root, 'process-store'), a = ref(), b = ref('executor-E')
  const first = await cli(['--root', dir, 'create', '--id', 'persistent-goal', '--title', 'Persistent',
    '--agent-ref', JSON.stringify('legacy-original'), '--agent-ref', JSON.stringify(a), '--assignees', JSON.stringify([a, b]), '--supervisor-ref', JSON.stringify(a)])
  expect(first.code).toBe(0)
  const file = join(dir, 'store.json'), bytes = await readFile(file), identity = await stat(file)
  const second = await cli(['--root', dir, 'show', '--id', 'persistent-goal'])
  expect(second.code).toBe(0); expect(second.pid).not.toBe(first.pid)
  expect(second.value.demand.sessionIds).toEqual(['legacy-original', a, b]); expect(second.value.demand.supervisorSessionId).toEqual(a)
  expect(second.value.demand.dispatches ?? []).toEqual([])
  expect(await readFile(file)).toEqual(bytes); const readIdentity = await stat(file)
  expect([readIdentity.dev, readIdentity.ino]).toEqual([identity.dev, identity.ino])
  const edit = await cli(['--root', dir, 'update', '--id', 'persistent-goal', '--description', 'keep original relations'])
  expect(edit.code).toBe(0); expect(edit.value.demand.sessionIds).toEqual(second.value.demand.sessionIds)
  const collision = await cli(['--root', dir, 'assign', '--id', 'persistent-goal', '--assignees', JSON.stringify([a]), '--assignee-session-id', 'same-SID'])
  expect(collision.code).toBe(1)
  const untouched = await cli(['--root', dir, 'show', '--id', 'persistent-goal'])
  expect(untouched.value.demand.assigneeSessionIds).toEqual([a, b])
})
