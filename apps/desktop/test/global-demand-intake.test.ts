import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('keeps the superseded Branch Board provider and duplicate dock out of the Goals app route', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  expect(app.length).toBeGreaterThan(0)
  expect(app).not.toContain('BoardRowsProvider')
  expect(app).toContain("const toolsAvailable = mainSurface === 'workbench' && Boolean(workspace)")
})
