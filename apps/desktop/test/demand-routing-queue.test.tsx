import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Demand routing queue', () => {
  it('exposes unassigned and assigned routing filters', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('Needs routing')
    expect(source).toContain('routingFilter')
    expect(source).toContain('executorFilter')
    expect(source).toContain('!demand.projectId || !demand.assigneeExecutorId')
    expect(source).toContain('Boolean(demand.projectId && demand.assigneeExecutorId)')
  })
})
