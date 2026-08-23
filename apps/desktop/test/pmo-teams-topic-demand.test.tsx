import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('PMO Teams Demand intake', () => {
  it('injects a clarification-first prompt into the fixed PMO Topic', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('PMO Teams Topic')
    expect(source).toContain('不要先创建空 Demand')
    expect(source).toContain('requestPmoTeamsTopicFloatingOpen')
  })
})
