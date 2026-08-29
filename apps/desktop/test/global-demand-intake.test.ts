import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('routes New Demand through a dedicated PMO Tab after creating the Demand', () => {
  const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/GlobalBoardSurface.tsx'), 'utf8')
  expect(source.length).toBeGreaterThan(0)
  expect(source).toContain('requestPmoTeamsTopicFloatingOpen')
  expect(source).toContain('openDemandPmo(demandId, prompt)')
  expect(source).toContain('targetTabId: tabId')
  expect(source).toContain('不要重复创建 Demand')
  expect(source).not.toContain("createDemand({ title: 'New demand'")
})
