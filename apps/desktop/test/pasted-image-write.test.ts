import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PASTED_IMAGE_EXTENSIONS, PASTED_IMAGE_MAX_BYTES } from '@agentmux/client-ui/pasted-images'
import { pastedDirectory } from '../src/main/pasted-directory'
import { readPastedImage } from '../src/main/pasted-image-read'
import { savePastedImage } from '../src/main/pasted-image-write'

const io = vi.hoisted(() => ({ beforeSync: undefined as undefined | ((path: string) => Promise<void>),
  beforeRead: undefined as undefined | ((path: string) => Promise<void>),
  afterLink: undefined as undefined | (() => void), unlinkFails: false }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
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
const bytes = Buffer.from('Original bytes, preserved without decoding or conversion')
afterEach(async () => { io.beforeSync = undefined; io.beforeRead = undefined; io.afterLink = undefined; io.unlinkFails = false; await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('original pasted image storage', () => {
  it.each([...PASTED_IMAGE_EXTENSIONS, 'unsupported'])('keeps %s extension semantics and the exact original bytes', async extension => {
    const root = await home(), result = await savePastedImage(root, { bytes, extension })
    expect(result).toEqual({ path: join(pastedDirectory(root), digest(bytes) + '.' + (extension === 'unsupported' ? 'png' : extension)),
      sha256: digest(bytes), byteLength: bytes.length, diskDurability: 'confirmed' })
    expect(await readFile(result.path)).toEqual(bytes)
    expect((await readPastedImage(root, result.path))?.dataUrl.split(',')[1]).toBe(bytes.toString('base64'))
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
    expect(await readdir(pastedDirectory(root))).toEqual([digest(bytes) + '.png'])
    const different = await savePastedImage(root, { bytes: Buffer.from('Another image'), extension: 'png' })
    expect(different.path).not.toBe(results[0]!.path)
  })

  it('refuses changed retained bytes without overwriting or deleting the original object', async () => {
    const root = await home(), original = await savePastedImage(root, { bytes, extension: 'png' }), changed = Buffer.alloc(bytes.length, 3)
    await writeFile(original.path, changed)
    io.unlinkFails = true
    let error: unknown
    try { await savePastedImage(root, { bytes, extension: 'png' }) } catch (value) { error = value }
    expect(error, 'changed retained bytes must not return a confirmed receipt').toBeInstanceOf(Error)
    expect((error as Error).message).toContain('differs from the original bytes')
    expect(await readFile(original.path), 'conflicting original bytes must remain unchanged').toEqual(changed)
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
    expect(result.path).toBe(join(pastedDirectory(root), digest(bytes) + '.png'))
    expect(await readdir(pastedDirectory(root))).toEqual([digest(bytes) + '.png'])
  })

  it('reconciles the same object after publication succeeded but its result was lost', async () => {
    const root = await home()
    io.afterLink = () => { throw new Error('Publication reply lost') }
    await expect(savePastedImage(root, { bytes, extension: 'png' })).rejects.toThrow('unconfirmed')
    const original = await readdir(pastedDirectory(root))
    io.afterLink = undefined
    const result = await savePastedImage(root, { bytes, extension: 'png' })
    expect(original).toEqual([digest(bytes) + '.png'])
    expect(await readdir(pastedDirectory(root))).toEqual(original)
    expect(await readFile(result.path)).toEqual(bytes)
  })
})
