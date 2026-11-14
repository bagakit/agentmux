import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const copies = vi.hoisted(() => ({ hold: false, entered: undefined as (() => void) | undefined, wait: undefined as Promise<void> | undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
    if (copies.hold) { copies.entered?.(); await copies.wait }
    return await fs.copyFile(...args)
  } }
})
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store'
import { WorkbenchCloseOwner } from '../src/main/workbench-close-owner'
import { DesktopStorageRecoveryExports } from '../src/main/storage-recovery-exports'
import { captureWorkbenchRecoveryFiles } from '../src/main/workbench-recovery-source'
import { createDesktopStorageRecoverySource } from '../../host/src/desktop-storage-recovery'
import type { RecoverySource } from '@agentmux/core'

const roots: string[] = []
const content = (text: string) => JSON.stringify({ version: 1, state: { agentComposerDrafts: { original: text } } })
afterEach(async () => { copies.hold = false; copies.entered = undefined; copies.wait = undefined; vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))) })
async function fixture() { const root = await mkdtemp('/tmp/amux-desktop-export-'); roots.push(root); return root }

it('exports exact original Main members once per capture ID and releases only private copies', async () => {
  const root = await fixture(), users = new WorkbenchUserStateStore(join(root, 'users.json')), windows = new WorkbenchWindowStore(join(root, 'windows.json'))
  await users.write(content('Original unsent input'))
  await windows.save({ mainWindowId: 'original-main', windows: [] })
  const close = new WorkbenchCloseOwner(users, {} as never)
  const auxiliary = [users.path + '.object-avatar-requests', users.path + '.file-view-reading', users.path + '.close-operations']
  for (const path of auxiliary) await mkdir(path)
  for (const path of auxiliary) await writeFile(join(path, 'a'.repeat(64) + '.json'), 'Original opaque owner bytes\n')
  await writeFile(join(auxiliary[2]!, 'a'.repeat(64) + '.json.apply'), 'Original apply marker\n')
  await writeFile(join(auxiliary[0]!, 'unrecognized-member'), 'Do not invent its role')
  const owner = new DesktopStorageRecoveryExports(join(root, 'exports'), () => [users.recoverySource(), windows.recoverySource(), close.recoverySource()])
  try {
    const one = owner.capture('original-capture'), same = owner.capture('original-capture')
    expect(same).toBe(one)
    const cut = await one
    expect(cut.members).toHaveLength(6)
    expect(cut.gaps).toContainEqual({ sourceId: 'desktop.user-state', memberId: 'object-avatar-requests/unrecognized-member', code: 'RECOVERY_MEMBER_UNRECOGNIZED' })
    for (const member of cut.members) {
      expect(await readFile(member.file)).toEqual(await readFile(member.target))
      expect(member.revision).toBeTypeOf('string')
    }
    expect(await owner.release('another-capture')).toEqual({ released: false })
    expect(await owner.release('original-capture')).toEqual({ released: true })
    for (const member of cut.members) {
      await expect(readFile(member.file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(member.target)).toBeDefined()
    }
    expect(await users.read()).toBe(content('Original unsent input'))
    expect(await owner.release('original-capture')).toEqual({ released: false })
  } finally { owner.dispose() }
})

it('metadata inspection creates no export or write and detects a real authored document replacement', async () => {
  const root = await fixture(), users = new WorkbenchUserStateStore(join(root, 'users.json'))
  await users.write(content('First'))
  const owner = new DesktopStorageRecoveryExports(join(root, 'exports'), () => [users.recoverySource()])
  const before = await owner.inspect()
  expect(await owner.inspect()).toEqual(before)
  await expect(readdir(join(root, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' })
  await users.write(content('Latest'))
  expect(await owner.inspect()).not.toEqual(before)
  expect(await users.read()).toBe(content('Latest'))
  owner.dispose()
})

it('a held read-only clone never blocks the original document writer and reports its changed cut', async () => {
  const root = await fixture(), users = new WorkbenchUserStateStore(join(root, 'users.json'))
  await users.write(content('Before capture'))
  let release!: () => void, entered!: () => void
  copies.wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  copies.entered = entered; copies.hold = true
  const capturing = users.recoverySource().capture(join(root, 'exports'))
  try {
    await started
    let confirmed = false
    const saving = users.write(content('New input remains writable')).then(() => { confirmed = true })
    await vi.waitFor(() => expect(confirmed).toBe(true), { timeout: 5000 })
    expect(await users.read()).toBe(content('New input remains writable'))
    await saving
  } finally { copies.hold = false; release() }
  const cut = await capturing
  expect(cut.gaps).toContainEqual({ sourceId: 'desktop.user-state', memberId: 'document', code: 'RECOVERY_SOURCE_CHANGED' })
  expect(cut.members).not.toContainEqual(expect.objectContaining({ id: 'document' }))
})

it('export cleanup never becomes a controlled-Quit barrier behind a missing read reply', async () => {
  const root = await fixture(); let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const source = { id: 'original-owner', inspect: async () => 'original-revision', capture: async () => { await pending; return { revision: 'original-revision', members: [], gaps: [] } } }
  const owner = new DesktopStorageRecoveryExports(join(root, 'exports'), () => [source])
  const capture = owner.capture('original-capture')
  await vi.waitFor(async () => expect(await readdir(join(root, 'exports'))).toHaveLength(1))
  expect(owner.dispose()).toBeUndefined()
  release(); await capture
  await vi.waitFor(async () => expect(await readdir(join(root, 'exports'))).toHaveLength(0))
})

it('a changed original dynamic namespace reports its missing cut without inventing a member', async () => {
  const root = await fixture(), namespace = join(root, 'original-members')
  await mkdir(namespace); await writeFile(join(namespace, 'first.json'), 'Original first member')
  let release!: () => void, entered!: () => void
  copies.wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  copies.entered = entered; copies.hold = true
  const capturing = captureWorkbenchRecoveryFiles('original-owner', join(root, 'exports'), [],
    [{ id: 'members', directory: namespace, accepts: name => name.endsWith('.json') }])
  try { await started; await writeFile(join(namespace, 'later.json'), 'Original later member') }
  finally { copies.hold = false; release() }
  const cut = await capturing
  expect(cut.members.map(member => member.id)).toEqual(['members/first.json'])
  expect(cut.gaps).toContainEqual({ sourceId: 'original-owner', memberId: 'members', code: 'RECOVERY_DIRECTORY_CHANGED' })
  expect(await readFile(join(namespace, 'later.json'), 'utf8')).toBe('Original later member')
})

it('Host polling inspects metadata and only dirties changed or recovered sources, with offline errors deduplicated', async () => {
  vi.useFakeTimers(); let current = 'original-revision', unavailable = false
  const call = vi.fn(async (method: string) => {
    expect(method).toBe('storage.source.inspect')
    if (unavailable) throw Object.assign(Error('Private Desktop offline'), { code: 'ECONNREFUSED' })
    return { revision: current }
  }), dispose = vi.fn(async () => {}), changed = vi.fn()
  const source: RecoverySource = createDesktopStorageRecoverySource(async () => ({ call, dispose }) as never)
  const stop = source.subscribe!(changed)
  try {
    await vi.advanceTimersByTimeAsync(30_000); expect(changed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000); expect(changed).toHaveBeenCalledTimes(1)
    current = 'new-revision'; await vi.advanceTimersByTimeAsync(30_000); expect(changed).toHaveBeenCalledTimes(2)
    unavailable = true; await vi.advanceTimersByTimeAsync(60_000); expect(changed).toHaveBeenCalledTimes(3)
    unavailable = false; await vi.advanceTimersByTimeAsync(30_000); expect(changed).toHaveBeenCalledTimes(4)
  } finally { stop() }
  const before = call.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000)
  expect(call).toHaveBeenCalledTimes(before); expect(dispose).toHaveBeenCalledTimes(before)
})

it('a child owner gap still identifies the outer Host recovery source and its original member', async () => {
  const root = await fixture()
  const call = vi.fn(async (method: string, params: { captureId: string }) => method === 'storage.source.capture'
    ? { captureId: params.captureId, revision: 'original-revision', members: [], gaps: [
      { sourceId: 'desktop.user-state', memberId: 'document', code: 'EIO' }, { sourceId: 'desktop.windows', code: 'EACCES' }
    ] } : { released: true })
  const source = createDesktopStorageRecoverySource(async () => ({ call, dispose: async () => {} }) as never)
  const result = await source.capture(join(root, 'output'))
  expect(result.gaps).toEqual([
    { sourceId: source.id, memberId: 'desktop.user-state/document', code: 'EIO' },
    { sourceId: source.id, memberId: 'desktop.windows/', code: 'EACCES' }
  ])
})
