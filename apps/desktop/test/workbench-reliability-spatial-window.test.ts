import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
const fault = vi.hoisted(() => ({ directorySync: false, calls: 0, directory: null as string | null }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if ((await handle.stat()).isDirectory()) { const sync = handle.sync.bind(handle); handle.sync = () => (fault.directory === String(args[0]) || fault.directorySync && ++fault.calls >= 2)
      ? Promise.reject(Object.assign(Error('controlled window directory EIO'), { code: 'EIO' })) : sync() }
    return handle
  } }
})
import { DesktopSpatialPersistence, SAVE_STALL_AFTER_MS } from '../src/renderer/src/lib/desktop-spatial-state'
import { runIndependentCheckpoints } from '../src/renderer/src/store/storage-checkpoint'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store'
const roots: string[] = []
const graph = (value: string): any => ({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: { original: value } })
afterEach(async () => { fault.directorySync = false; fault.calls = 0; fault.directory = null; vi.clearAllTimers(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'amux-reliability-spatial-')); roots.push(root); return root }

it('bootstrap starts the original watchdog and autonomously recovers its first missing read reply', async () => {
  vi.useFakeTimers(); let reads = 0, saved: any = null
  const warnings = vi.fn(), owner = new DesktopSpatialPersistence({ read: async () => {
    if (++reads === 2) return await new Promise<never>(() => {})
    return saved
  }, commit: async ({ graph }: any) => saved = { schemaVersion: 1, revision: 1, graph }, onChange: () => () => {} }, warnings)
  await owner.read()
  const first = owner.bootstrap(graph('first')).catch(error => error)
  await vi.advanceTimersByTimeAsync(SAVE_STALL_AFTER_MS)
  expect(warnings).toHaveBeenCalledOnce(); expect(owner.saveObservation.pendingSince).not.toBeNull()
  expect((await first).code).toBe('SPATIAL_REPLY_OVERDUE')
  owner.stage(graph('later'))
  await vi.advanceTimersByTimeAsync(SAVE_STALL_AFTER_MS)
  await owner.flush()
  expect(saved.graph.resources.original).toBe('later'); expect(owner.pendingChanges).toBe(false)
  owner.dispose()
})

it('bootstrap unknown first commit preserves later input and disjoint remote changes without a new identity', async () => {
  vi.useFakeTimers(); let saved: any = null, commits = 0
  const warnings = vi.fn(), owner = new DesktopSpatialPersistence({ read: async () => saved,
    commit: async (input: any) => {
      expect(input.expectedRevision).toBe(saved?.revision ?? 0)
      saved = { schemaVersion: 1, revision: (saved?.revision ?? 0) + 1, graph: structuredClone(input.graph) }
      if (++commits === 1) return await new Promise<never>(() => {})
      return saved
    }, onChange: () => () => {} }, warnings)
  await owner.read(); const first = owner.bootstrap(graph('first')).catch(error => error)
  await vi.advanceTimersByTimeAsync(SAVE_STALL_AFTER_MS); await first
  saved = { ...saved, revision: saved.revision + 1, graph: { ...saved.graph, resources: { ...saved.graph.resources, remote: 'kept' } } }
  owner.stage(graph('later'))
  await vi.advanceTimersByTimeAsync(SAVE_STALL_AFTER_MS); await owner.flush()
  expect(saved.graph.resources).toEqual({ original: 'later', remote: 'kept' })
  expect(saved.graph.regions).toEqual([]); expect(commits).toBe(2)
  owner.dispose()
})

it('independent checkpoints save real user data while an original spatial peer has not replied', async () => {
  const root = await fixture(), user = new WorkbenchUserStateStore(join(root, 'user.json'))
  let release!: () => void
  const spatial = new Promise<void>(resolve => { release = resolve }), main = vi.fn(async () => {})
  const checkpoint = runIndependentCheckpoints([() => spatial, () => user.write(JSON.stringify({ version: 1, state: { agentComposerDrafts: { original: 'authored' } } })).then(() => {}), main])
  await vi.waitFor(() => expect(main).toHaveBeenCalledOnce())
  await vi.waitFor(async () => expect(await user.read()).toContain('authored'))
  release(); await checkpoint
})

const arrangement = { mainWindowId: 'original-main', windows: [{ windowId: 'original-window', target: { kind: 'region' as const,
  displayWorkspaceId: 'original-workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-browser-region' },
  geometry: { x: 10, y: 20, width: 900, height: 600, maximized: false } }] }
it('window arrangement requires a directory ACK and reports after-replace unknown', async () => {
  const root = await fixture(), owner = new WorkbenchWindowStore(join(root, 'windows.json'))
  fault.directorySync = true
  await expect(owner.save(arrangement)).rejects.toMatchObject({ phase: 'after-replace', code: 'EIO' })
  expect(JSON.parse(await readFile(join(root, 'windows.json'), 'utf8')).windows[0].windowId).toBe('original-window')
  fault.directorySync = false; await owner.save(arrangement)
  expect((await new WorkbenchWindowStore(join(root, 'windows.json')).load()).state).toEqual(arrangement)
})

it('a new operation namespace requires its original parent ACK again after an unknown first attempt', async () => {
  const root = await fixture(), owner = new WorkbenchWindowStore(join(root, 'windows.json'))
  const operation: any = { method: 'app.window.open', input: { operationId: 'original-operation', target: arrangement.windows[0]!.target },
    actor: { kind: 'user', id: 'desktop' }, state: 'pending', windowId: 'original-window', documentGeneration: null, message: null }
  fault.directory = root
  await expect(owner.saveOperation(operation)).rejects.toMatchObject({ code: 'EIO' })
  await expect(owner.saveOperation(operation)).rejects.toMatchObject({ code: 'EIO' })
  expect(await owner.operation('original-operation')).toBeNull()
  fault.directory = null; await owner.saveOperation(operation)
  expect(await owner.operation('original-operation')).toEqual(operation)
})

it('second real process restores the same confirmed window and Browser Region reference', async () => {
  const root = await fixture(), path = join(root, 'windows.json'), owner = new WorkbenchWindowStore(path)
  await owner.save(arrangement)
  const worker = join(root, 'read-window.mjs')
  await writeFile(worker, `import {WorkbenchWindowStore} from ${JSON.stringify(resolve('apps/desktop/src/main/workbench-window-store.ts'))};process.stdout.write(JSON.stringify({pid:process.pid,result:await new WorkbenchWindowStore(process.argv[2]).load()}));`)
  const processRead = spawnSync(process.execPath, ['--import', resolve('packages/core/scripts/helpers/core-source-loader.mjs'), worker, path], { encoding: 'utf8', timeout: 20000 })
  expect(processRead.status, processRead.stderr).toBe(0)
  const actual = JSON.parse(processRead.stdout); expect(actual.pid).not.toBe(process.pid); expect(actual.result).toEqual({ state: arrangement, writable: true, issue: null })
})
