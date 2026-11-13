import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { WorkspaceMediaStreams, parseByteRange } from '../src/main/workspace-media-streams.js'
import { WorkspaceFiles, compareMediaWitness, type WorkspaceMediaWitness } from '../src/main/workspace-files.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

const roots: string[] = []
const owners: WorkspaceMediaStreams[] = []

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'agentmux-media-stream-'))
  roots.push(base)
  const root = join(base, 'workspace')
  await mkdir(join(root, 'clips'), { recursive: true })
  const workspace: WorkspaceRecord = { id: 'workspace', name: 'Media', hostId: 'local', path: root, kind: 'folder' }
  let current: WorkspaceRecord | undefined = workspace
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const streams = new WorkspaceMediaStreams(files, id => current?.id === id ? current : undefined)
  owners.push(streams)
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))
  await writeFile(join(root, 'clips/clip.mp4'), bytes)
  return { base, root, workspace, files, streams, bytes, setWorkspace: (next: WorkspaceRecord | undefined) => { current = next } }
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request(target, { method, headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function ready(f: Awaited<ReturnType<typeof fixture>>, path = 'clips/clip.mp4') {
  const opened = await f.streams.open(f.workspace, path)
  if (opened.status !== 'ready') throw new Error(`stream not ready: ${JSON.stringify(opened)}`)
  return opened
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('byte range parsing', () => {
  it.each([
    ['bytes=0-', { start: 0, end: 99 }], ['bytes=10-19', { start: 10, end: 19 }], ['bytes=90-500', { start: 90, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }], ['bytes=-500', { start: 0, end: 99 }]
  ])('%s', (header, expected) => expect(parseByteRange(header, 100)).toEqual(expected))
  it.each(['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-1', 'bytes=1e3-'])('%s is unsatisfiable', header =>
    expect(parseByteRange(header, 100)).toBe('unsatisfiable'))
  it('no header serves the whole file', () => expect(parseByteRange(undefined, 100)).toBeNull())
})

describe('pinned media identity', () => {
  const pinned: WorkspaceMediaWitness = { device: '1', inode: '100', size: 4096n, mtimeNs: 10n, ctimeNs: 20n }
  it('the same object at the same path is unchanged', () => expect(compareMediaWitness(pinned, { ...pinned }, { ...pinned })).toBe('same'))
  it.each([
    ['another inode at the path', { inode: '101' }, 'visible'], ['another device at the path', { device: '2' }, 'visible'],
    ['a different length', { size: 4160n }, 'opened'], ['a newer modification time', { mtimeNs: 11n }, 'opened'],
    ['a newer change time', { ctimeNs: 21n }, 'opened']
  ] as const)('%s is changed', (_, field, side) => {
    const changed = { ...pinned, ...field }
    expect(compareMediaWitness(pinned, side === 'opened' ? changed : { ...pinned }, side === 'visible' ? changed : { ...pinned })).toBe('changed')
  })
})

describe('workspace media stream leases', () => {
  it('serves whole, ranged and HEAD reads of a file larger than the old whole-file preview budget without a snapshot read', async () => {
    const f = await fixture(), snapshot = vi.spyOn(f.files, 'snapshotBytes')
    const opened = await ready(f)
    expect(opened).toMatchObject({ kind: 'video', mimeType: 'video/mp4', byteLength: 4096 })
    expect(opened.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new URL(opened.url).hostname).toBe('127.0.0.1')
    const whole = await get(opened.url)
    expect(whole.status).toBe(200)
    expect(whole.body).toEqual(f.bytes)
    expect(whole.headers['accept-ranges']).toBe('bytes')
    expect(whole.headers['content-type']).toBe('video/mp4')
    const part = await get(opened.url, { Range: 'bytes=1000-1099' })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 1000-1099/4096')
    expect(part.headers['content-length']).toBe('100')
    expect(part.body).toEqual(f.bytes.subarray(1000, 1100))
    const tail = await get(opened.url, { Range: 'bytes=-16' })
    expect(tail.body).toEqual(f.bytes.subarray(4080))
    const beyond = await get(opened.url, { Range: 'bytes=4096-' })
    expect(beyond.status).toBe(416)
    expect(beyond.headers['content-range']).toBe('bytes */4096')
    const head = await get(opened.url, { Range: 'bytes=0-9' }, 'HEAD')
    expect(head.status).toBe(206)
    expect(head.body.byteLength).toBe(0)
    for (const header of ['cache-control', 'x-content-type-options', 'referrer-policy', 'content-security-policy']) expect(whole.headers[header]).toBeTruthy()
    expect(whole.headers['access-control-allow-origin']).toBeUndefined()
    expect(snapshot).not.toHaveBeenCalled()
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })

  it('refuses unknown tokens, other paths, foreign Host, script Origin, document destinations and mutating methods', async () => {
    const f = await fixture(), opened = await ready(f)
    await writeFile(join(f.root, 'clips/other.mp4'), 'other bytes')
    const url = new URL(opened.url)
    const attempts: Array<[string, Record<string, string>, string?]> = [
      [`${url.origin}/${'A'.repeat(43)}${url.pathname.slice(44)}`, {}],
      [new URL('./other.mp4', opened.url).href, {}],
      [opened.url, { Host: 'attacker.example' }],
      [opened.url, { Origin: 'http://attacker.example' }],
      [opened.url, { 'Sec-Fetch-Dest': 'empty' }],
      [opened.url, { 'Sec-Fetch-Dest': 'document' }]
    ]
    expect(attempts.length).toBe(6)
    for (const [target, headers] of attempts) {
      const reply = await get(target, headers)
      expect(reply.status).toBe(404)
      expect(reply.body.toString()).not.toContain('other bytes')
    }
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await get(opened.url, {}, method)).status).toBe(405)
    expect((await get(opened.url, { 'Sec-Fetch-Dest': 'video' })).status).toBe(200)
    expect((await get(opened.url, { 'Sec-Fetch-Dest': 'audio' })).status).toBe(200)
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })

  it('pins the opened file object: atomic replace and in-place rewrite are reported as changed, never served as mixed bytes', async () => {
    const f = await fixture(), replaced = await ready(f)
    const pinned = await import('node:fs/promises').then(fs => fs.stat(join(f.root, 'clips/clip.mp4')))
    // Same length and timestamps under a new inode: only the object identity can tell them apart.
    await writeFile(join(f.root, 'clips/next.mp4'), Buffer.alloc(4096, 7))
    await utimes(join(f.root, 'clips/next.mp4'), pinned.atime, pinned.mtime)
    await rename(join(f.root, 'clips/next.mp4'), join(f.root, 'clips/clip.mp4'))
    const afterReplace = await get(replaced.url, { Range: 'bytes=0-15' })
    expect(afterReplace.status).toBe(410)
    expect(afterReplace.body.includes(7)).toBe(false)
    expect(f.streams.status(replaced.id)).toEqual({ state: 'changed', path: 'clips/clip.mp4' })

    const rewritten = await ready(f)
    expect((await get(rewritten.url, { Range: 'bytes=0-3' })).status).toBe(206)
    // Same inode and length, newer content: only the change time and mtime record it.
    const later = new Date(Date.now() + 5_000)
    await writeFile(join(f.root, 'clips/clip.mp4'), Buffer.alloc(4096, 9), { flag: 'r+' })
    await utimes(join(f.root, 'clips/clip.mp4'), later, later)
    expect((await get(rewritten.url, { Range: 'bytes=0-3' })).status).toBe(410)
    expect(f.streams.status(rewritten.id)).toMatchObject({ state: 'changed' })
  })

  it('ends a response already sending when the pinned file is rewritten in place, never mixing in new bytes', async () => {
    const f = await fixture(), size = 4 * 1024 * 1024, path = join(f.root, 'clips/long.mp4')
    await writeFile(path, Buffer.alloc(size, 3))
    const opened = await ready(f, 'clips/long.mp4')
    const target = new URL(opened.url), received: Buffer[] = []
    const outcome = await new Promise<{ status: number; ended: 'complete' | 'aborted' }>((resolve, reject) => {
      const req = request(target, { headers: { Range: `bytes=0-${size - 1}` } }, response => {
        // Hold the reader after the first chunk so the owner is mid-response, then rewrite the same inode.
        response.once('data', async chunk => {
          received.push(chunk); response.pause()
          const later = new Date(Date.now() + 5_000)
          await writeFile(path, Buffer.alloc(size, 9), { flag: 'r+' }); await utimes(path, later, later)
          response.on('data', more => received.push(more)); response.resume()
        })
        response.on('end', () => resolve({ status: response.statusCode!, ended: 'complete' }))
        response.on('aborted', () => resolve({ status: response.statusCode!, ended: 'aborted' }))
        response.on('error', () => resolve({ status: response.statusCode!, ended: 'aborted' }))
      })
      req.on('error', reject); req.end()
    })
    const body = Buffer.concat(received)
    expect(outcome.status).toBe(206)
    expect(outcome.ended).toBe('aborted')
    expect(body.length).toBeLessThan(size)
    expect(body.includes(9)).toBe(false)
    expect(f.streams.status(opened.id)).toEqual({ state: 'changed', path: 'clips/long.mp4' })
  })

  it('reports a growing file as changed rather than serving past its pinned length', async () => {
    const f = await fixture(), growing = await ready(f)
    const before = await import('node:fs/promises').then(fs => fs.stat(join(f.root, 'clips/clip.mp4')))
    await appendFile(join(f.root, 'clips/clip.mp4'), Buffer.alloc(64, 1))
    // Restore the timestamp so the length is the only recorded difference.
    await utimes(join(f.root, 'clips/clip.mp4'), before.atime, before.mtime)
    expect((await get(growing.url)).status).toBe(410)
    expect(f.streams.status(growing.id)).toMatchObject({ state: 'changed' })
  })

  it('a failed identity probe refuses only that request: the pinned file plays again once the probe succeeds', async () => {
    const f = await fixture(), opened = await ready(f)
    const lease = (f.streams as unknown as { leases: Map<string, { media: { current(): Promise<string> } }> }).leases.get(opened.id)!
    const real = lease.media.current.bind(lease.media)
    lease.media.current = async () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }) }
    expect((await get(opened.url, { Range: 'bytes=0-3' })).status).toBe(500)
    expect(f.streams.status(opened.id)).toEqual({ state: 'read-error', path: 'clips/clip.mp4', code: 'EACCES' })
    lease.media.current = real
    const again = await get(opened.url, { Range: 'bytes=0-3' })
    expect(again.status).toBe(206); expect(again.body).toEqual(f.bytes.subarray(0, 4))
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })

  it('reports a deleted file as deleted', async () => {
    const f = await fixture()
    const deleted = await ready(f)
    await rm(join(f.root, 'clips/clip.mp4'))
    expect((await get(deleted.url)).status).toBe(404)
    expect(f.streams.status(deleted.id)).toEqual({ state: 'deleted', path: 'clips/clip.mp4' })
    expect(await f.streams.open(f.workspace, 'clips/clip.mp4')).toMatchObject({ status: 'deleted' })
  })

  it('confines links to the real Workspace root and refuses non-regular files, directories and remote Hosts', async () => {
    const f = await fixture()
    await writeFile(join(f.base, 'outside.mp4'), 'outside secret')
    await symlink(join(f.base, 'outside.mp4'), join(f.root, 'clips/escape.mp4'))
    expect(await f.streams.open(f.workspace, 'clips/escape.mp4')).toMatchObject({ status: 'unavailable', code: 'WORKSPACE_PATH_ESCAPE' })
    await symlink(join(f.root, 'clips/clip.mp4'), join(f.root, 'clips/inside.mp4'))
    const inside = await ready(f, 'clips/inside.mp4')
    expect((await get(inside.url)).body).toEqual(f.bytes)
    execFileSync('mkfifo', [join(f.root, 'clips/pipe.mp4')])
    expect(await f.streams.open(f.workspace, 'clips/pipe.mp4')).toMatchObject({ status: 'unavailable', code: 'WORKSPACE_MEDIA_NOT_REGULAR' })
    await mkdir(join(f.root, 'clips/folder.mp4'))
    expect(await f.streams.open(f.workspace, 'clips/folder.mp4')).toEqual({ status: 'directory' })
    expect(await f.streams.open(f.workspace, '../outside.mp4')).toMatchObject({ status: 'unavailable', code: 'WORKSPACE_PATH_ESCAPE' })
    expect(await f.streams.open(f.workspace, 'clips/notes.txt')).toMatchObject({ status: 'unsupported' })
    const remote = new WorkspaceMediaStreams(new WorkspaceFiles(() => ({ kind: 'ssh' }) as never), () => f.workspace)
    owners.push(remote)
    expect(await remote.open(f.workspace, 'clips/clip.mp4')).toMatchObject({ status: 'unavailable', code: 'REMOTE_WORKSPACE_PREVIEW_UNAVAILABLE' })
  })

  it('reports a path that later leaves the Workspace as outside it, not as a codec failure', async () => {
    const f = await fixture(), opened = await ready(f)
    await writeFile(join(f.base, 'outside.mp4'), f.bytes)
    await rm(join(f.root, 'clips/clip.mp4'))
    await symlink(join(f.base, 'outside.mp4'), join(f.root, 'clips/clip.mp4'))
    expect((await get(opened.url)).status).toBe(403)
    expect(f.streams.status(opened.id)).toEqual({ state: 'outside-workspace', path: 'clips/clip.mp4' })
  })

  it('release ends in-flight bytes and invalidates the URL; releaseAll fences opens that started before it', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'clips/large.mp4'), Buffer.alloc(32 * 1024 * 1024, 3))
    const opened = await ready(f, 'clips/large.mp4')
    let received = 0
    const outcome = await new Promise<'ended' | 'aborted' | 'still-streaming'>(resolve => {
      const req = request(new URL(opened.url), response => {
        response.on('data', chunk => {
          if (received === 0) {
            f.streams.release(opened.id)
            // A released lease must end this response promptly instead of streaming the rest.
            setTimeout(() => resolve('still-streaming'), 1_000)
          }
          received += chunk.length
        })
        response.on('end', () => resolve('ended'))
        response.on('aborted', () => resolve('aborted'))
        response.on('error', () => resolve('aborted'))
      })
      req.on('error', () => resolve('aborted'))
      req.end()
    })
    expect(outcome).toBe('aborted')
    expect(received).toBeLessThan(32 * 1024 * 1024)
    expect(f.streams.status(opened.id)).toEqual({ state: 'released' })
    expect((await get(opened.url)).status).toBe(404)

    const pending = f.streams.open(f.workspace, 'clips/clip.mp4')
    f.streams.releaseAll()
    expect(await pending).toMatchObject({ status: 'unavailable', code: 'WORKSPACE_MEDIA_RELEASED' })
  })

  it('stops serving when the original Workspace resource changes', async () => {
    const f = await fixture(), opened = await ready(f)
    f.setWorkspace({ ...f.workspace, path: join(f.base, 'elsewhere') })
    expect((await get(opened.url)).status).toBe(410)
    expect(f.streams.status(opened.id)).toMatchObject({ state: 'changed' })
  })
})
