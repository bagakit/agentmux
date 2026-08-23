import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('routes New Demand through PMO Teams without creating an empty card', () => {
  const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/GlobalBoardSurface.tsx'), 'utf8')
  expect(source.length).toBeGreaterThan(0)
  expect(source).toContain('requestPmoTeamsTopicFloatingOpen')
  expect(source).toContain('不要先创建空 Demand')
  expect(source).not.toContain("createDemand({ title: 'New demand'")
})
