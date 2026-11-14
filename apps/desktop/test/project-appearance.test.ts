import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, rename, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAppearance as probe, sniffImageMime } from '../src/main/project-appearance'

import { controlledNativeImage, imagePng } from './fixtures/mote-identity-image'
import { projectIconImage } from '../src/main/project-icon-image'
import type { NativeImage } from 'electron'
import { SpaceObjectImages } from '../src/main/space-object-images'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw Error('The Node fixture must inject its decoder.') } } }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open), readdir: vi.fn(fs.readdir) }
})

const projectAppearance = (root: string) => probe(root, controlledNativeImage)

// Real PNG/GIF/WebP signatures — the probe sniffs these, never the extension.
const PNG = imagePng(16, 16)
const GIF = Buffer.from('GIF89a\0\0\0\0', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function newRoot(): Promise<string> { const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-appearance-'))); roots.push(root); return root }
async function put(root: string, rel: string, bytes: Buffer): Promise<void> {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
}

describe('sniffImageMime beats a lying extension', () => {
  it('reads the format from magic bytes, not the caller-supplied name', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(GIF)).toBe('image/gif')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
    expect(sniffImageMime(SVG)).toBe('image/svg+xml')
    // Plain text — including text that *names* an image — is not an image.
    expect(sniffImageMime(Buffer.from('this is not a png, honest'))).toBeNull()
  })
})

describe('projectAppearance', () => {
  it('returns the folder fallback (icon null) for a project with no icon at all', async () => {
    const root = await newRoot()
    await put(root, 'README.md', Buffer.from('# hi'))
    expect(await projectAppearance(root)).toEqual({ kind: 'directory', icon: null })
  })

  it('marks a repository by .git and still finds no icon', async () => {
    const root = await newRoot()
    await mkdir(join(root, '.git'))
    expect(await projectAppearance(root)).toEqual({ kind: 'repository', icon: null })
  })

  it('hits a conventional prefix location', async () => {
    const root = await newRoot()
    await put(root, 'public/favicon.png', PNG)
    expect(await projectAppearance(root)).toMatchObject({ icon: expect.stringContaining('data:image/png;base64,') })
  })

  it('finds an icon buried 3 levels deep — the fixed list alone would miss it (0/10)', async () => {
    const root = await newRoot()
    // The measured real shape: apps/desktop/resources/icon.png — three segments below the root,
    // under no conventional prefix.
    await put(root, 'apps/desktop/resources/logo-192.webp', WEBP)
    expect(await projectAppearance(root)).toMatchObject({ icon: expect.stringContaining('data:image/webp;base64,') })
  })

  it('finds the project icon without spending its directory budget on hidden tool data', async () => {
    const root = await newRoot()
    await Promise.all(Array.from({ length: 410 }, (_, index) =>
      mkdir(join(root, '.tool-cache', `run-${index}`), { recursive: true })))
    await put(root, 'packages/client/resources/icon.png', PNG)
    expect(await projectAppearance(root)).toEqual({
      kind: 'directory', icon: `data:image/png;base64,${PNG.toString('base64')}`
    })
  })

  it('does not borrow an identity from hidden tool data', async () => {
    const root = await newRoot()
    await put(root, '.tool-cache/icon.png', PNG)
    await put(root, 'client/resources/logo.webp', WEBP)
    expect(await projectAppearance(root)).toEqual({
      kind: 'directory', icon: `data:image/webp;base64,${WEBP.toString('base64')}`
    })
  })

  it('trusts magic bytes over a lying extension: a text file named icon.png is not the icon', async () => {
    const root = await newRoot()
    // MUTATION TARGET #3: if the probe encodes by extension instead of sniffing, this text file named
    // `.png` would be served as image/png. It must be rejected and the real deep icon found instead.
    await put(root, 'icon.png', Buffer.from('<html>not an image</html>'))
    await put(root, 'assets/brand/logo.gif', GIF)
    const result = await projectAppearance(root)
    expect(result.icon).toContain('data:image/gif;base64,')
    expect(result.icon).not.toContain('image/png')
  })

  it('does not walk into node_modules — the skip-list is load-bearing', async () => {
    const root = await newRoot()
    // MUTATION TARGET #1: only icon lives under node_modules. If the skip-list is removed the probe
    // walks in and returns it; with the skip-list it must find nothing.
    await put(root, 'node_modules/some-pkg/icon.png', PNG)
    expect(await projectAppearance(root)).toEqual({ kind: 'directory', icon: null })
  })

  it('does not descend past the depth bound', async () => {
    const root = await newRoot()
    // MUTATION TARGET #2: the only icon sits one level below the bound (4 dirs deep). Within the bound
    // nothing is found; raising the bound would surface it.
    await put(root, 'a/b/c/d/icon.png', PNG)
    expect(await projectAppearance(root)).toEqual({ kind: 'directory', icon: null })
  })

  it('enforces the size cap before serving oversized bytes', async () => {
    const root = await newRoot()
    // Exceeds the source byte budget even before image decoding.
    await put(root, 'icon.png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))
    await put(root, 'small/logo.png', PNG)
    // The oversized top-level icon is skipped; the small deep one wins.
    expect(await projectAppearance(root)).toMatchObject({ icon: expect.stringContaining('data:image/png;base64,') })
    // And when the oversized file is the ONLY candidate, we fall back rather than serve it.
    const solo = await newRoot()
    await put(solo, 'icon.png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))
    expect(await projectAppearance(solo)).toEqual({ kind: 'directory', icon: null })
  })

  it('recognizes the actual large packaged project artwork through the same discovery owner', async () => {
    const original = await readFile(new URL('../resources/icon.png', import.meta.url))
    expect(original.length).toBeGreaterThan(256 * 1024)
    expect(original.length).toBeLessThanOrEqual(1024 * 1024)
    const root = await newRoot()
    await put(root, 'client/resources/icon.png', original)
    const decode = vi.fn(controlledNativeImage)
    const result = await probe(root, decode)
    expect(decode).toHaveBeenCalledOnce()
    const output = Buffer.from(result.icon!.split(',')[1]!, 'base64')
    expect(output.length).toBeLessThanOrEqual(256 * 1024)
    expect(output.readUInt32BE(16)).toBe(512)
    expect(output.readUInt32BE(20)).toBe(512)
    expect(await readFile(join(root, 'client/resources/icon.png'))).toEqual(original)
    expect(await probe(root, decode)).toEqual(result)
    expect(decode).toHaveBeenCalledOnce()
  })

  it('publishes discovered artwork through the actual local object image consumer and its injected decoder', async () => {
    const root = await newRoot()
    await put(root, 'resources/icon.png', imagePng(1024, 512))
    const decode = vi.fn(controlledNativeImage)
    const local = new SpaceObjectImages(async () => ({ hostId: 'local', directoryPath: root }), decode)
    const target = { kind: 'category' as const, categoryId: 'original-category', objectKey: 'original-object' }
    const result = await local.appearance(target)
    expect(result.local).toBe(true)
    expect(result.icon).not.toBeNull()
    expect(decode).toHaveBeenCalledOnce()
    const remote = new SpaceObjectImages(async () => ({ hostId: 'remote', directoryPath: root }), decode)
    expect(await remote.appearance(target)).toEqual({ local: false, icon: null })
    expect(decode).toHaveBeenCalledOnce()
  })

  it('chooses a shallow conventional asset before a deeper mark and sorts sibling directories', async () => {
    const root = await newRoot()
    // Deliberately create the lexically later directory first.
    await put(root, 'z-product/icon.svg', Buffer.from('<svg>later</svg>'))
    await put(root, 'a-product/icon.svg', SVG)
    const fs = await import('node:fs/promises'), entries = await fs.readdir(root, { withFileTypes: true })
    // Filesystems need not enumerate children in name order.
    const spy = vi.mocked(fs.readdir).mockResolvedValueOnce(entries.sort((a, b) => b.name.localeCompare(a.name)) as never)
    try { expect((await projectAppearance(root)).icon).toBe(`data:image/svg+xml;base64,${SVG.toString('base64')}`) }
    finally { spy.mockClear() }
    await put(root, 'public/favicon.svg', Buffer.from('<svg>conventional</svg>'))
    // Root-level directory entries did not change; wait-free re-probe follows the winner signature.
    await rename(join(root, 'a-product/icon.svg'), join(root, 'a-product/old.svg'))
    expect((await projectAppearance(root)).icon).toContain(Buffer.from('<svg>conventional</svg>').toString('base64'))
  })

  it('caps candidate attempts even in one directory', async () => {
    const root = await newRoot()
    for (let index = 0; index < 140; index++) await put(root, `icon-${String(index).padStart(3, '0')}.png`, Buffer.from('invalid'))
    await put(root, 'icon-999.svg', SVG)
    expect((await projectAppearance(root)).icon).toBeNull()
  })

  it('shares one byte budget across the conventional probes and the walk', async () => {
    const root = await newRoot(), invalid = Buffer.alloc(1024 * 1024)
    await put(root, 'icon.png', invalid)
    for (let index = 0; index < 3; index++) await put(root, `icon-${index}.png`, invalid)
    await put(root, 'nested/icon.svg', SVG)
    expect((await projectAppearance(root)).icon).toBeNull()
  })

  it('retains original containment and refreshes the winner after its bytes change', async () => {
    const root = await newRoot(), outside = await newRoot()
    await put(outside, 'icon.svg', Buffer.from('<svg>outside</svg>'))
    await symlink(join(outside, 'icon.svg'), join(root, 'icon.svg'))
    await put(root, 'assets/icon.svg', SVG)
    expect((await projectAppearance(root)).icon).toBe(`data:image/svg+xml;base64,${SVG.toString('base64')}`)
    const changed = Buffer.from('<svg>updated original image</svg>')
    await put(root, 'assets/icon.svg', changed)
    expect((await projectAppearance(root)).icon).toBe(`data:image/svg+xml;base64,${changed.toString('base64')}`)
  })

  it('reports unavailable storage instead of caching a confirmed absence', async () => {
    const root = await newRoot()
    const failure = Object.assign(new Error('Storage unavailable'), { code: 'EIO' })
    const fs = await import('node:fs/promises'), original = vi.mocked(fs.open).getMockImplementation()!
    const spy = vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(root)) throw failure
      return original(...args)
    })
    try {
      await put(root, 'icon.svg', SVG)
      await expect(projectAppearance(root)).rejects.toBe(failure)
    } finally { spy.mockImplementation(original) }
    expect((await projectAppearance(root)).icon).not.toBeNull()
  })
})

describe('project artwork publication', () => {
  it('preserves aspect ratio and rejects a native decoder mismatch or oversized output', () => {
    const bytes = imagePng(1024, 256)
    const image = projectIconImage(bytes, 'image/png', controlledNativeImage)!
    expect(image.bytes.readUInt32BE(16)).toBe(512)
    expect(image.bytes.readUInt32BE(20)).toBe(128)
    const mismatch = vi.fn(() => controlledNativeImage(imagePng(8, 8)))
    expect(projectIconImage(bytes, 'image/png', mismatch)).toBeNull()
    const hugeOutput = () => ({ isEmpty: () => false, getSize: () => ({ width: 1024, height: 256 }),
      resize: () => ({ getSize: () => ({ width: 512, height: 128 }), toPNG: () => Buffer.alloc(256 * 1024 + 1) }) }) as unknown as NativeImage
    expect(projectIconImage(bytes, 'image/png', hugeOutput)).toBeNull()
  })

  it('checks encoded dimensions before decoding, and keeps existing bounded SVG support', () => {
    const bytes = Buffer.from(PNG); bytes.writeUInt32BE(100_000, 16)
    const decode = vi.fn(controlledNativeImage)
    expect(projectIconImage(bytes, 'image/png', decode)).toBeNull()
    expect(decode).not.toHaveBeenCalled()
    expect(projectIconImage(SVG, 'image/svg+xml', decode)).toEqual({ bytes: SVG, mime: 'image/svg+xml' })
    expect(projectIconImage(Buffer.alloc(256 * 1024 + 1), 'image/svg+xml', decode)).toBeNull()
    expect(projectIconImage(Buffer.from('invalid'), 'image/png', decode)).toBeNull()
  })
})
