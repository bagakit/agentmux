import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('global Demand Board production surface', () => {
  it('contains the Demand-first card, routing filters, and fixed detail workspace', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url)), 'utf8')
    for (const anchor of ['DemandCard', 'DemandWorkspace', 'routingFilter', 'plannedStartAt', 'AgentTopologySummary', 'requestPmoTeamsTopicFloatingOpen']) expect(source).toContain(anchor)
  })

  it('persists an explicit New Demand before opening PMO with that Demand identity', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url)), 'utf8')
    const create = source.indexOf('const demandId = createDemand(')
    const open = source.indexOf('openDemandPmo(demandId, prompt)', create)
    expect(create).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(create)
    expect(source.slice(create, open)).toContain("status: 'backlog'")
    expect(source.slice(open - 700, open + 300)).toContain('Demand ${demandId}')
    // Direct Topic chat owns the clarification decision; the Board button is the only path that pre-creates.
    expect(source).toContain('从 Board 的 New Demand 入口接到已创建的 Demand')
  })
})
