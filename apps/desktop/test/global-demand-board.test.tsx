import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('global Demand Board production surface', () => {
  it('contains the Demand-first card, routing filters, and fixed detail workspace', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url)), 'utf8')
    for (const anchor of ['DemandCard', 'DemandWorkspace', 'routingFilter', 'plannedStartAt', 'AgentTopologySummary', 'requestPmoTeamsTopicFloatingOpen']) expect(source).toContain(anchor)
  })
})
