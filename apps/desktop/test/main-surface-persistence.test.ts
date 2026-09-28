import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFile(
  fileURLToPath(new URL('../src/renderer/src/store.ts', import.meta.url)),
  'utf8'
)

describe('main surface persistence', () => {
  it('restores Search through the same durable mainSurface projection', async () => {
    const source = await SOURCE
    const restoreStart = source.indexOf('function restoredMainSurface(candidate: unknown): MainSurface {')
    expect(restoreStart).toBeGreaterThan(-1)
    const restoreEnd = source.indexOf('\n}\n', restoreStart)
    expect(restoreEnd).toBeGreaterThan(restoreStart)
    const restoreBody = source.slice(restoreStart, restoreEnd)
    expect(restoreBody).toContain("candidate === 'survey'")
    expect(source).toContain('mainSurface: state.mainSurface')
  })
})
