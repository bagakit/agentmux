import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('routes New Demand through a dedicated PMO Tab after creating the Demand', () => {
  // 基址取本文件的位置而不是 `process.cwd()`：cwd 取决于谁在哪一层发起 vitest，从仓根跑
  // （`pnpm test:fast` 就是）解析成 `<repo>/src/…` 直接 ENOENT，从 apps/desktop 跑才对。
  // 同一条判据在两个目录下一红一绿，那不是判据，是掷硬币。
  const source = readFileSync(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url), 'utf8')
  expect(source.length).toBeGreaterThan(0)
  expect(source).toContain('requestPmoTeamsTopicFloatingOpen')
  expect(source).toContain('openDemandPmo(demandId, prompt)')
  expect(source).toContain('targetTabId: tabId')
  expect(source).toContain('不要重复创建 Demand')
  expect(source).not.toContain("createDemand({ title: 'New demand'")
})
