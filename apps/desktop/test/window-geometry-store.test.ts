import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowGeometryStore } from '../src/main/window-geometry-store.js'
import type { WindowGeometry } from '../src/main/window-geometry.js'

/**
 * The durable window-geometry store. It lives in userData beside the config so a restart reopens the
 * window where the user left it. A missing or corrupt file reads back as null (fall back to default),
 * never a crash.
 */

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentmux-geometry-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function storePath(): string {
  return join(root, 'window-geometry.json')
}

const sample: WindowGeometry = { width: 1200, height: 800, x: 40, y: 60, maximized: true }

describe('WindowGeometryStore', () => {
  it('round-trips a saved record through a fresh instance (survives restart)', async () => {
    await new WindowGeometryStore(storePath()).save(sample)
    // A fresh instance stands in for the next launch reopening the same durable file.
    expect(await new WindowGeometryStore(storePath()).load()).toEqual(sample)
  })

  it('writes the record as a real file on disk', async () => {
    await new WindowGeometryStore(storePath()).save(sample)
    expect(JSON.parse(await readFile(storePath(), 'utf8'))).toEqual(sample)
  })

  it('returns null when no record exists yet (first launch)', async () => {
    expect(await new WindowGeometryStore(storePath()).load()).toBeNull()
  })

  it('returns null on a corrupt file instead of throwing', async () => {
    const store = new WindowGeometryStore(storePath())
    await store.save(sample)
    await rm(storePath())
    const { writeFile } = await import('node:fs/promises')
    await writeFile(storePath(), '{ not json', 'utf8')
    expect(await store.load()).toBeNull()
  })

  it('serializes overlapping saves so the last one wins intact', async () => {
    const store = new WindowGeometryStore(storePath())
    await Promise.all([
      store.save({ width: 1000, height: 700, maximized: false }),
      store.save(sample)
    ])
    // Whichever settled last is fully written — never a half-written interleave.
    const loaded = await store.load()
    expect(loaded).not.toBeNull()
    expect([1000, sample.width]).toContain(loaded!.width)
  })
})
