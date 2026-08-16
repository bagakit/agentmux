import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readPastedImage } from '../src/main/pasted-image-read.js'
import { pastedDirectory } from '../src/main/pasted-directory.js'
import { PASTED_IMAGE_MAX_BYTES } from '../src/shared/contracts.js'

// T-003: the read's trust boundary is the pasted directory, not a workspace root. These tests exercise
// the real function against a real temp directory — a data URI comes back for a genuine pasted image,
// and every rejection path (escape, sibling-directory look-alike, non-image extension, oversize,
// absent) returns null rather than an empty/broken data URI.

let home: string
let dir: string
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'pasted-read-'))
  dir = pastedDirectory(home)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'paste-1.png'), PNG_BYTES)
  await writeFile(join(dir, 'note.txt'), 'not an image')
})

afterAll(async () => {
  // Best-effort; the temp root is under the OS temp dir.
  const { rm } = await import('node:fs/promises')
  await rm(home, { recursive: true, force: true })
})

describe('readPastedImage — reads inside the pasted directory', () => {
  it('returns an <img>-ready data URI for a real pasted image', async () => {
    const image = await readPastedImage(home, join(dir, 'paste-1.png'))
    expect(image).not.toBeNull()
    expect(image!.mimeType).toBe('image/png')
    expect(image!.dataUrl).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`)
    expect(image!.byteLength).toBe(PNG_BYTES.byteLength)
  })

  it('maps jpg and jpeg to image/jpeg from the shared mime table', async () => {
    await writeFile(join(dir, 'shot.jpeg'), PNG_BYTES)
    const image = await readPastedImage(home, join(dir, 'shot.jpeg'))
    expect(image!.mimeType).toBe('image/jpeg')
    expect(image!.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
  })
})

describe('readPastedImage — the boundary is the directory', () => {
  it('rejects a path outside the pasted directory', async () => {
    expect(await readPastedImage(home, join(home, 'secret.png'))).toBeNull()
  })

  it('rejects a ../ escape that resolves outside the directory', async () => {
    // A genuine escape sample, not a pre-normalised one: `<dir>/../secret.png` resolves to
    // `<home>/secret.png`, outside the directory. The containment test must resolve THEN compare.
    await writeFile(join(home, 'secret.png'), PNG_BYTES)
    expect(await readPastedImage(home, join(dir, '..', 'secret.png'))).toBeNull()
  })

  it('rejects a sibling directory whose name is a bare prefix of the pasted dir', async () => {
    // `<home>/.agentmux/pasted-evil/x.png` has `<dir>` as a bare string prefix but is a DIFFERENT
    // directory. Confinement must be `startsWith(dir + sep)`, not a raw prefix — this is the exact
    // false-accept the design doc calls out.
    const evil = `${dir}-evil`
    await mkdir(evil, { recursive: true })
    await writeFile(join(evil, 'x.png'), PNG_BYTES)
    expect(await readPastedImage(home, join(evil, 'x.png'))).toBeNull()
  })

  it('rejects a symlink inside the directory that points outside it — and leaks no bytes', async () => {
    // Lexical `resolve()` is pure string math and cannot see a symlink: a link INSIDE the pasted dir
    // pointing at an external file is lexically in-bounds, so a lexical-only check reads foreign bytes
    // and encodes them into a data URI (verified exploitable). Containment must resolve the REAL path.
    // Two assertions, not one: null alone is also satisfied by a `return null` mutant; the second pins
    // that the secret content never rode out in the result. Mutation point: swap realpath→resolve, red.
    const secretDir = await mkdtemp(join(tmpdir(), 'pasted-secret-'))
    const secret = join(secretDir, 'stolen.png')
    await writeFile(secret, Buffer.from('SECRET-EXFIL'))
    const { symlink } = await import('node:fs/promises')
    await symlink(secret, join(dir, 'link.png'))
    const image = await readPastedImage(home, join(dir, 'link.png'))
    expect(image).toBeNull()
    expect(JSON.stringify(image)).not.toContain('SECRET')
    expect(JSON.stringify(image)).not.toContain(Buffer.from('SECRET-EXFIL').toString('base64'))
    const { rm } = await import('node:fs/promises')
    await rm(secretDir, { recursive: true, force: true })
  })

  it('rejects a non-image extension even inside the directory', async () => {
    expect(await readPastedImage(home, join(dir, 'note.txt'))).toBeNull()
  })

  it('rejects an absent file with an identifiable null, not an empty data URI', async () => {
    const image = await readPastedImage(home, join(dir, 'does-not-exist.png'))
    expect(image).toBeNull()
  })

  it('rejects an oversized file before it would be pulled into memory', async () => {
    // One byte over the cap. Written sparse via truncate so the test does not allocate 16MB+.
    const big = join(dir, 'huge.png')
    const { open } = await import('node:fs/promises')
    const handle = await open(big, 'w')
    await handle.truncate(PASTED_IMAGE_MAX_BYTES + 1)
    await handle.close()
    expect(await readPastedImage(home, big)).toBeNull()
  })

  it('rejects an empty file (a zero-byte data URI is a silent broken image)', async () => {
    await writeFile(join(dir, 'empty.png'), Buffer.alloc(0))
    expect(await readPastedImage(home, join(dir, 'empty.png'))).toBeNull()
  })
})
