import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { WORKSPACE_FILE_MAX_BYTES, WORKSPACE_FILE_MAX_READ_BYTES } from '../src/shared/workspace-file-bytes.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

const race = vi.hoisted(() => ({ beforeInput: null as null | (() => Promise<void>), beforePublish: false }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (args[0] === process.execPath && race.beforePublish) {
      const values = [...args[1]!]
      const source = values[2]!
      const anchor = '          if (request.exclusive) {'
      expect(source.split(anchor)).toHaveLength(2)
      // A controlled competitor creates the real target after the final revision check.
      // The commit syscall and path confinement remain the actual production worker.
      values[2] = source.replace(anchor, `          const competitor = await open(request.name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)\n          try { await competitor.writeFile(Buffer.from([77, 0, 255])) } finally { await competitor.close() }\n` + anchor)
      args[1] = values
      race.beforePublish = false
    }
    const child = actual.spawn(...args)
    if (args[0] === process.execPath && child.stdin) {
      const end = child.stdin.end.bind(child.stdin)
      child.stdin.end = ((...values: Parameters<typeof end>) => {
        const hook = race.beforeInput
        race.beforeInput = null
        if (!hook) return end(...values)
        void hook().then(() => end(...values), error => child.stdin?.destroy(error))
        return child.stdin
      }) as typeof child.stdin.end
    }
    return child
  } }
})

const roots: string[] = []
const revision = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'agentmux-file-bytes-'))
  roots.push(base)
  const root = join(base, 'workspace')
  await mkdir(root)
  const workspace: WorkspaceRecord = { id: 'binary-workspace', name: 'Binary', hostId: 'local', path: root, kind: 'folder' }
  return { root, base, workspace, files: new WorkspaceFiles(() => new LocalExecutionHost()) }
}
afterEach(async () => {
  race.beforeInput = null
  race.beforePublish = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('WorkspaceFiles binary owner', () => {
  it('publishes exact binary bytes and returns bounded ranges with the actual total and revision', async () => {
    const { root, workspace, files } = await fixture()
    const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 1])
    await expect(files.writeBytes(workspace, { path: 'report.bin', bytes })).resolves.toEqual({ status: 'written', revision: revision(bytes) })
    expect(await readFile(join(root, 'report.bin'))).toEqual(bytes)
    const chunk = await files.readBytes(workspace, 'report.bin', { offset: 1, maxBytes: 3 })
    expect(chunk).toEqual({ bytes: Buffer.from([255, 128, 13]), totalBytes: 7, revision: revision(bytes), offset: 1, returnedBytes: 3, nextOffset: 4, readCost: { payloadBytes: 7 } })
    await expect(files.readBytes(workspace, 'report.bin', { offset: 4, expectedRevision: chunk.revision })).resolves.toEqual({ bytes: Buffer.from([10, 0, 1]), totalBytes: 7, revision: revision(bytes), offset: 4, returnedBytes: 3, nextOffset: null, readCost: { payloadBytes: 7 } })
  })

  it('does not overwrite another file and refuses a changed revision', async () => {
    const { root, workspace, files } = await fixture()
    const original = Buffer.from([0, 255, 2])
    await writeFile(join(root, 'keep.bin'), original)
    await expect(files.writeBytes(workspace, { path: 'keep.bin', bytes: Buffer.from([3, 4]) })).resolves.toEqual({ status: 'conflict', observedRevision: revision(original) })
    expect(await readFile(join(root, 'keep.bin'))).toEqual(original)
    await writeFile(join(root, 'keep.bin'), Buffer.from([0, 255, 3]))
    await expect(files.readBytes(workspace, 'keep.bin', { expectedRevision: revision(original) })).rejects.toMatchObject({ code: 'WORKSPACE_FILE_REVISION_MISMATCH' })
  })

  it('snapshots a file larger than a public chunk in one bounded verified scan', async () => {
    const { root, workspace, files } = await fixture()
    const bytes = Buffer.alloc(WORKSPACE_FILE_MAX_READ_BYTES + 3, 128)
    bytes[0] = 0
    bytes[bytes.length - 1] = 255
    await writeFile(join(root, 'upload.bin'), bytes)
    const snapshot = await files.snapshotBytes(workspace, 'upload.bin')
    expect(Buffer.from(snapshot.bytes).equals(bytes)).toBe(true)
    expect({ ...snapshot, bytes: undefined }).toEqual({ bytes: undefined, totalBytes: bytes.length, revision: revision(bytes), offset: 0, returnedBytes: bytes.length, nextOffset: null, readCost: { payloadBytes: bytes.length } })
    await expect(files.snapshotBytes(workspace, 'upload.bin', { expectedRevision: revision(Buffer.from([1])) })).rejects.toMatchObject({ code: 'WORKSPACE_FILE_REVISION_MISMATCH' })
  })

  it('atomically preserves a competitor created after the final revision check', async () => {
    const { root, workspace, files } = await fixture()
    race.beforePublish = true
    const competitor = Buffer.from([77, 0, 255])
    await expect(files.writeBytes(workspace, { path: 'contended.bin', bytes: Buffer.from([0, 1]) })).resolves.toEqual({ status: 'conflict', observedRevision: revision(competitor) })
    expect(await readFile(join(root, 'contended.bin'))).toEqual(competitor)
    expect(race.beforePublish).toBe(false)
  })

  it('rejects outside links and traversal for both publishing and reading bytes', async () => {
    const { base, workspace, files } = await fixture()
    const outside = join(base, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.bin'), Buffer.from([9, 0, 255]))
    await symlink(outside, join(workspace.path, 'link'), 'dir')
    await expect(files.readBytes(workspace, 'link/secret.bin')).rejects.toThrow('escapes')
    await expect(files.writeBytes(workspace, { path: 'link/new.bin', bytes: Buffer.from([0, 1]) })).resolves.toMatchObject({ status: 'error' })
    await expect(files.writeBytes(workspace, { path: '../outside/new.bin', bytes: Buffer.from([0, 1]) })).resolves.toMatchObject({ status: 'error' })
    expect(await readFile(join(outside, 'secret.bin'))).toEqual(Buffer.from([9, 0, 255]))
  })

  it('pins the checked byte read directory across a path replacement race', async () => {
    const { root, base, workspace, files } = await fixture()
    const checked = join(root, 'checked'), held = join(root, 'held'), outside = join(base, 'outside')
    await Promise.all([mkdir(checked), mkdir(outside)])
    await Promise.all([writeFile(join(checked, 'value.bin'), Buffer.from([0, 1])), writeFile(join(outside, 'value.bin'), Buffer.from([0, 99]))])
    race.beforeInput = async () => { await rename(checked, held); await symlink(outside, checked, 'dir') }
    expect((await files.readBytes(workspace, 'checked/value.bin')).bytes).toEqual(Buffer.from([0, 1]))
    expect(race.beforeInput).toBeNull()
  })

  it('pins the checked binary publication directory across a path replacement race', async () => {
    const { root, base, workspace, files } = await fixture()
    const checked = join(root, 'checked'), held = join(root, 'held'), outside = join(base, 'outside')
    await Promise.all([mkdir(checked), mkdir(outside)])
    race.beforeInput = async () => { await rename(checked, held); await symlink(outside, checked, 'dir') }
    await expect(files.writeBytes(workspace, { path: 'checked/new.bin', bytes: Buffer.from([0, 255]) })).resolves.toEqual({ status: 'written', revision: revision(Buffer.from([0, 255])) })
    expect(await readFile(join(held, 'new.bin'))).toEqual(Buffer.from([0, 255]))
    await expect(readFile(join(outside, 'new.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(race.beforeInput).toBeNull()
  })

  it('enforces allocation and byte response limits before reading payloads', async () => {
    const { root, workspace, files } = await fixture()
    await writeFile(join(root, 'large.bin'), '')
    await truncate(join(root, 'large.bin'), WORKSPACE_FILE_MAX_BYTES + 1)
    let failure: unknown
    try { await files.readBytes(workspace, 'large.bin') } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ code: 'WORKSPACE_FILE_BYTE_LIMIT' })
    let snapshotFailure: unknown
    try { await files.snapshotBytes(workspace, 'large.bin') } catch (error) { snapshotFailure = error }
    expect(snapshotFailure).toBeInstanceOf(Error)
    expect(snapshotFailure).toMatchObject({ code: 'WORKSPACE_FILE_BYTE_LIMIT' })
    await expect(files.readBytes(workspace, 'large.bin', { maxBytes: WORKSPACE_FILE_MAX_READ_BYTES + 1 })).rejects.toThrow('maxBytes')
    await expect(files.readBytes(workspace, 'large.bin', { offset: -1 })).rejects.toThrow('offset')
    await expect(files.writeBytes(workspace, { path: 'too-large.bin', bytes: Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1) })).resolves.toMatchObject({ status: 'error', code: 'WORKSPACE_FILE_BYTE_LIMIT' })
  })
})
