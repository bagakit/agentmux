import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deriveObjectId } from '@agentmux/core/object-id'
import { PASTED_IMAGE_EXTENSIONS, PASTED_IMAGE_MAX_BYTES } from '@agentmux/client-ui/pasted-images'
import { pastedDirectory } from '../src/main/pasted-directory'
import { readPastedImage } from '../src/main/pasted-image-read'
import { savePastedImage } from '../src/main/pasted-image-write'

const io = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((path: string) => void),
  beforeSync: undefined as undefined | ((path: string) => Promise<void>),
  beforeRead: undefined as undefined | ((path: string) => Promise<void>),
  afterLink: undefined as undefined | (() => void), unlinkFails: false }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      io.beforeOpen?.(String(args[0]))
      const file = await fs.open(...args), sync = file.sync.bind(file)
      file.sync = async () => { await io.beforeSync?.(String(args[0])); await sync() }
      const read = file.read.bind(file)
      file.read = (async (...values: unknown[]) => { await io.beforeRead?.(String(args[0])); return await (read as (...values: unknown[]) => Promise<unknown>)(...values) }) as typeof file.read
      return file
    },
    link: async (...args: Parameters<typeof fs.link>) => { await fs.link(...args); io.afterLink?.() },
    unlink: async (...args: Parameters<typeof fs.unlink>) => { if (io.unlinkFails) throw new Error('Private temporary cleanup failed'); await fs.unlink(...args) }
  }
})
const homes: string[] = []
async function home() { const value = await mkdtemp(join(tmpdir(), 'amux-pasted-')); homes.push(value); return value }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const objectName = (bytes: Uint8Array, extension = 'png') =>
  `paste-${deriveObjectId('pasted-image.v1', JSON.stringify([digest(bytes), extension]))}.${extension}`
const bytes = Buffer.from('Original bytes, preserved without decoding or conversion')
afterEach(async () => { io.beforeOpen = undefined; io.beforeSync = undefined; io.beforeRead = undefined; io.afterLink = undefined; io.unlinkFails = false; await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('original pasted image storage', () => {
  it.each([...PASTED_IMAGE_EXTENSIONS, 'unsupported'])('keeps %s extension semantics and the exact original bytes', async extension => {
    const root = await home(), result = await savePastedImage(root, { bytes, extension })
    expect(result).toEqual({ path: join(pastedDirectory(root), objectName(bytes, extension === 'unsupported' ? 'png' : extension)),
      sha256: digest(bytes), byteLength: bytes.length, diskDurability: 'confirmed' })
    expect(await readFile(result.path)).toEqual(bytes)
    expect((await readPastedImage(root, result.path))?.dataUrl.split(',')[1]).toBe(bytes.toString('base64'))
  })

  it('derives stable short Base58 names from the full hash and normalized extension', async () => {
    const root = await home(), expected = join(pastedDirectory(root), objectName(bytes))
    const first = await savePastedImage(root, { bytes, extension: 'png' })
    expect(first.path).toBe(expected)
    expect(first.path).toMatch(/\/paste-[1-9A-HJ-NP-Za-km-z]{12}\.png$/u)
    expect(await savePastedImage(root, { bytes, extension: 'png' })).toEqual(first)
    expect(await savePastedImage(root, { bytes, extension: 'unsupported' })).toEqual(first)
    const jpeg = await savePastedImage(root, { bytes, extension: 'jpeg' })
    expect(jpeg.path).toBe(join(pastedDirectory(root), objectName(bytes, 'jpeg')))
    expect(jpeg.path).not.toBe(first.path)
    const different = await savePastedImage(root, { bytes: Buffer.from('Different original bytes'), extension: 'png' })
    expect(different.path).not.toBe(first.path)
  })

  it('keeps the original nonempty and 16 MiB byte boundary without a new decoder gate', async () => {
    const root = await home()
    await expect(savePastedImage(root, { bytes: Buffer.alloc(0), extension: 'png' })).rejects.toThrow('empty')
    await expect(savePastedImage(root, { bytes: Buffer.alloc(PASTED_IMAGE_MAX_BYTES + 1), extension: 'png' })).rejects.toThrow('size limit')
    const exact = Buffer.alloc(PASTED_IMAGE_MAX_BYTES, 7), result = await savePastedImage(root, { bytes: exact, extension: 'png' })
    expect(result.byteLength).toBe(PASTED_IMAGE_MAX_BYTES)
    expect((await readFile(result.path)).equals(exact)).toBe(true)
    expect(await readPastedImage(root, result.path)).not.toBeNull()
  })

  it('copies caller bytes before asynchronous work and publishes one object for concurrent identical retries', async () => {
    const root = await home(), input = Buffer.from(bytes), saving = savePastedImage(root, { bytes: input, extension: 'png' })
    input.fill(0)
    const results = await Promise.all([saving, ...Array.from({ length: 4 }, () => savePastedImage(root, { bytes, extension: 'png' }))])
    expect(new Set(results.map(value => value.path)).size).toBe(1)
    expect(await readFile(results[0]!.path)).toEqual(bytes)
    expect(await readdir(pastedDirectory(root))).toEqual([objectName(bytes)])
    const different = await savePastedImage(root, { bytes: Buffer.from('Another image'), extension: 'png' })
    expect(different.path).not.toBe(results[0]!.path)
  })

  it('refuses changed retained bytes without overwriting or deleting the original object', async () => {
    const root = await home(), directory = pastedDirectory(root), changed = Buffer.alloc(bytes.length, 3)
    const originalPath = join(directory, objectName(bytes))
    await mkdir(directory, { recursive: true })
    await writeFile(originalPath, changed)
    io.unlinkFails = true
    let error: unknown
    try { await savePastedImage(root, { bytes, extension: 'png' }) } catch (value) { error = value }
    expect(error, 'changed retained bytes must not return a confirmed receipt').toBeInstanceOf(Error)
    expect((error as Error).message).toContain('differs from the original bytes')
    expect(await readFile(originalPath), 'conflicting original bytes must remain unchanged').toEqual(changed)
    expect((await readdir(directory)).filter(name => !name.endsWith('.partial')), 'a collision must not mint a random suffix or a second final object').toEqual([objectName(bytes)])
  })

  it('accepts concurrent identical bytes when the original publisher removes its private hard link', async () => {
    const root = await home()
    let reached!: () => void, release!: () => void, firstDirectory = true
    const ready = new Promise<void>(resolve => { reached = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
    io.beforeSync = async path => { if (path === dirname(pastedDirectory(root)) && firstDirectory) { firstDirectory = false; reached(); await blocked } }
    const first = savePastedImage(root, { bytes, extension: 'png' }); await ready
    let observed = false
    io.beforeRead = async path => {
      if (path.endsWith('.png') && !observed) { observed = true; release(); await first }
    }
    const second = await savePastedImage(root, { bytes, extension: 'png' }).then(receipt => ({ receipt }), error => ({ error }))
    expect(observed).toBe(true)
    expect(second, 'legitimate publisher cleanup must not invalidate identical original bytes').not.toHaveProperty('error')
    expect('receipt' in second && second.receipt).toEqual(await first)
  })

  it('does not expose the final path before the complete temporary file is synced', async () => {
    const root = await home()
    let reached!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { reached = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    io.beforeSync = async path => { if (path.endsWith('.partial')) { reached(); await waiting } }
    const saving = savePastedImage(root, { bytes, extension: 'png' }); await ready
    try { expect((await readdir(pastedDirectory(root))).filter(name => !name.endsWith('.partial'))).toEqual([]) }
    finally { release() }
    expect((await saving).diskDurability).toBe('confirmed')
  })

  it.each(['temporary', 'directory'])('does not report success when %s synchronization is unconfirmed', async phase => {
    const root = await home()
    io.beforeSync = async path => { if (phase === 'temporary' ? path.endsWith('.partial') : path === pastedDirectory(root)) throw new Error('Original synchronization unconfirmed') }
    let error: unknown
    try { await savePastedImage(root, { bytes, extension: 'png' }) } catch (value) { error = value }
    expect(error, 'synchronization failure must not produce a successful path').toBeInstanceOf(Error)
    expect((error as Error).message).toContain('save is unconfirmed')
    io.beforeSync = undefined
    const result = await savePastedImage(root, { bytes, extension: 'png' })
    expect(result.path).toBe(join(pastedDirectory(root), objectName(bytes)))
    expect(await readdir(pastedDirectory(root))).toEqual([objectName(bytes)])
  })

  it('reconciles the same object after publication succeeded but its result was lost', async () => {
    const root = await home()
    io.afterLink = () => { throw new Error('Publication reply lost') }
    await expect(savePastedImage(root, { bytes, extension: 'png' })).rejects.toThrow('unconfirmed')
    const original = await readdir(pastedDirectory(root))
    io.afterLink = undefined
    const result = await savePastedImage(root, { bytes, extension: 'png' })
    expect(original).toEqual([objectName(bytes)])
    expect(await readdir(pastedDirectory(root))).toEqual(original)
    expect(await readFile(result.path)).toEqual(bytes)
  })

  it('reuses a matching legacy SHA object without publishing a short-name copy', async () => {
    const root = await home(), directory = pastedDirectory(root), legacyPath = join(directory, digest(bytes) + '.png')
    await mkdir(directory, { recursive: true })
    await writeFile(legacyPath, bytes)
    const result = await savePastedImage(root, { bytes, extension: 'png' })
    expect(result).toEqual({ path: legacyPath, sha256: digest(bytes), byteLength: bytes.length, diskDurability: 'confirmed' })
    expect(await savePastedImage(root, { bytes, extension: 'png' })).toEqual(result)
    expect((await readPastedImage(root, legacyPath))?.dataUrl.split(',')[1]).toBe(bytes.toString('base64'))
    expect(await readdir(directory)).toEqual([digest(bytes) + '.png'])
  })

  it.each(['changed', 'unreadable'] as const)('refuses a %s legacy object without hiding it behind a short-name copy', async condition => {
    const root = await home(), directory = pastedDirectory(root), legacyPath = join(directory, digest(bytes) + '.png')
    const original = Buffer.from('Legacy bytes that must remain untouched')
    await mkdir(directory, { recursive: true })
    await writeFile(legacyPath, original)
    if (condition === 'unreadable') io.beforeOpen = path => {
      if (path === legacyPath) throw Object.assign(new Error('Legacy read denied'), { code: 'EACCES' })
    }
    let error: unknown
    try { await savePastedImage(root, { bytes, extension: 'png' }) } catch (value) { error = value }
    expect(error, 'only ENOENT may permit publishing a new short name').toBeInstanceOf(Error)
    expect((error as Error).message).toContain('save is unconfirmed')
    expect(await readFile(legacyPath)).toEqual(original)
    expect(await readdir(directory)).toEqual([digest(bytes) + '.png'])
  })
})
