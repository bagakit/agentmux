import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Demand restart recovery', () => {
  it('hydrates Demand facts from the filesystem package and keeps the projection on failure', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/store.ts', import.meta.url)), 'utf8')
    expect(source).toContain('api.demands.list()')
    const demandStartup = source.slice(source.indexOf('api.demands.list()') - 220, source.indexOf('api.demands.list()') + 80)
    expect(demandStartup).toContain('Promise.allSettled')
    expect(source).toContain('demandRecordFromFilesystem')
    expect(source).toContain("demandResult.status === 'rejected'")
    expect(source).toContain('demandResult.value.length > 0')
    expect(source).toContain('set({ demands: Object.fromEntries')
  })
})
