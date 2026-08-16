import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAppearance, sniffImageMime } from '../src/main/project-appearance'

// Real PNG/GIF/WebP signatures — the probe sniffs these, never the extension.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const GIF = Buffer.from('GIF89a\0\0\0\0', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function newRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'amx-appearance-')); roots.push(root); return root }
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
    // A valid PNG whose size exceeds 256KiB: the header sniffs fine, so only the size check rejects it.
    await put(root, 'icon.png', Buffer.concat([PNG, Buffer.alloc(300 * 1024)]))
    await put(root, 'small/logo.png', PNG)
    // The oversized top-level icon is skipped; the small deep one wins.
    expect(await projectAppearance(root)).toMatchObject({ icon: expect.stringContaining('data:image/png;base64,') })
    // And when the oversized file is the ONLY candidate, we fall back rather than serve it.
    const solo = await newRoot()
    await put(solo, 'icon.png', Buffer.concat([PNG, Buffer.alloc(300 * 1024)]))
    expect(await projectAppearance(solo)).toEqual({ kind: 'directory', icon: null })
  })
})
