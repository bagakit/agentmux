import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore, type AgentMuxSpatialGraph } from '../src/spatial-state.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../src/spatial-layout.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const member = { spaceId: 'mote', hostId: 'local', agentSessionId: 'main' }
function graph(root: string, bound = true, unrelated = 0): AgentMuxSpatialGraph {
  const ids = ['main', ...Array.from({ length: unrelated }, (_, i) => 'unrelated-' + i)]
  return {
    spaces: [{ spaceId: 'mote', kind: 'mote', name: 'Mote', hostId: 'local', directoryPath: root, projectId: null },
      ...ids.slice(1).map(id => ({ spaceId: id, kind: 'folder' as const, name: id, hostId: 'local', directoryPath: join(root, id), projectId: null }))],
    zones: ids.map(id => ({ zoneId: id, workspaceId: 'homes', kind: 'directory' as const, hostId: 'local', directoryPath: join(root, id), branch: null })),
    bindings: [...(bound ? [{ spaceId: 'mote', zoneId: 'main' }] : []), ...ids.slice(1).map(id => ({ spaceId: id, zoneId: id }))],
    tabs: ids.map(id => ({ tabId: id, zoneId: id, workspaceId: 'homes', name: null, regionIds: [id] })),
    regions: ids.map(id => ({ tabId: id, regionId: id, kind: 'agent' as const, agentSessionId: id, runId: null, execution: { hostId: 'local', cwd: root } })),
    layouts: { homes: createWorkspaceLayout('group', ids) },
    tabLayouts: Object.fromEntries(ids.map(id => [id, createWorkbenchViewLayout(id)])), resources: {}
  }
}
async function fixture(unrelated = 0) {
  const root = await mkdtemp(join(tmpdir(), 'spatial-membership-')); roots.push(root)
  const store = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const saved = await store.commit({ expectedRevision: 0, graph: graph(root, true, unrelated) })
  return { root, store, saved }
}
// Count real private owner work, without adding production metrics or a second graph owner.
const ownerWork = (store: AgentMuxSpatialStateStore) => ({
  decode: vi.spyOn(store as any, 'decode'), build: vi.spyOn(store as any, 'readAgentIndex')
})

it('reuses one exact file index for concurrent and warm queries despite unrelated spatial growth', async () => {
  const { store } = await fixture(500), work = ownerWork(store)
  const values = await Promise.all(Array.from({ length: 20 }, () => store.readSpaceAgentMembership(member)))
  expect(values).toEqual(Array.from({ length: 20 }, () => ({ spaceKind: 'mote', member: true })))
  for (let i = 0; i < 20; i++) expect(await store.readSpaceAgentMembership(member)).toEqual({ spaceKind: 'mote', member: true })
  expect(work.decode).toHaveBeenCalledTimes(1); expect(work.build).toHaveBeenCalledTimes(1)
  expect(await store.readSpaceAgentMembership({ ...member, hostId: 'remote' })).toEqual({ spaceKind: 'mote', member: false })
  expect(await store.readSpaceAgentMembership({ ...member, spaceId: 'absent' })).toEqual({ spaceKind: null, member: false })
})

it('sees local commits and external same-revision replacements without trusting mutable public graphs', async () => {
  const { root, store, saved } = await fixture()
  expect(await store.readSpaceAgentMembership(member)).toEqual({ spaceKind: 'mote', member: true })
  saved.graph.bindings.length = 0
  const publicRead = (await store.read())!; publicRead.graph.regions.length = 0
  expect(await store.readSpaceAgentMembership(member)).toEqual({ spaceKind: 'mote', member: true })
  const second = await store.commit({ expectedRevision: 1, graph: graph(root, false) })
  expect(await store.readSpaceAgentMembership(member)).toEqual({ spaceKind: 'mote', member: false })
  const replacement = join(root, 'replacement.json')
  await writeFile(replacement, JSON.stringify({ ...second, graph: graph(root) }))
  await rename(replacement, store.path)
  expect(await store.readSpaceAgentMembership(member)).toEqual({ spaceKind: 'mote', member: true })
  expect((await store.read())!.revision).toBe(second.revision)
})

it('does not authorize from a cached positive after deletion or malformed bytes and recovers on repair', async () => {
  const { store, saved } = await fixture()
  expect((await store.readSpaceAgentMembership(member))!.member).toBe(true)
  await rm(store.path)
  expect(await store.readSpaceAgentMembership(member)).toBeNull()
  await writeFile(store.path, '{original broken bytes')
  await expect(store.readSpaceAgentMembership(member)).rejects.toMatchObject({ code: 'SPATIAL_STATE_READ_UNCONFIRMED' })
  expect(await readFile(store.path, 'utf8')).toBe('{original broken bytes')
  await writeFile(store.path, JSON.stringify(saved))
  expect((await store.readSpaceAgentMembership(member))!.member).toBe(true)
})

it.each([false, true])('an older cold read cannot clear a newer file index when it later fails=%s', async fail => {
  const { root, store, saved } = await fixture(), work = ownerWork(store)
  // Save the original method before replacing only this first load with a controlled wait.
  work.build.mockRestore()
  const build = (store as any).readAgentIndex.bind(store)
  let begin!: () => void, release!: () => void
  const begun = new Promise<void>(resolve => { begin = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const counted = vi.spyOn(store as any, 'readAgentIndex').mockImplementationOnce(async (file: unknown) => {
    begin(); await held
    if (fail) throw new Error('original read unavailable')
    return build(file)
  })
  const old = store.readSpaceAgentMembership(member)
  const outcome = old.then(value => ({ value }), error => ({ error }))
  await begun
  const replacement = join(root, 'new.json')
  await writeFile(replacement, JSON.stringify({ ...saved, graph: graph(root, false) })); await rename(replacement, store.path)
  expect((await store.readSpaceAgentMembership(member))!.member).toBe(false)
  release()
  const finished = await outcome
  if (fail) expect(finished).toMatchObject({ error: { message: 'original read unavailable' } })
  else expect(finished).toMatchObject({ value: { member: true } })
  expect((await store.readSpaceAgentMembership(member))!.member).toBe(false)
  expect(counted).toHaveBeenCalledTimes(2)
  expect(work.decode).toHaveBeenCalledTimes(fail ? 1 : 2)
})

it('does not reuse a file observation changed in place during its original read', async () => {
  const { store } = await fixture(), work = ownerWork(store)
  const decode = (store as any).decode.bind(store)
  work.decode.mockImplementationOnce((text: unknown) => {
    appendFileSync(store.path, ' ')
    return decode(text)
  })
  expect((await store.readSpaceAgentMembership(member))!.member).toBe(true)
  expect((await store.readSpaceAgentMembership(member))!.member).toBe(true)
  expect(work.build).toHaveBeenCalledTimes(2)
})
