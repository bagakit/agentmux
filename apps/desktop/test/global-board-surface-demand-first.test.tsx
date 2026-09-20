import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('keeps Goals isolated from the shared Focus stylesheet and uses a single horizontal board track', () => {
  const source = readFileSync(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/renderer/src/styles/goals.css', import.meta.url), 'utf8')
  expect(source.length).toBeGreaterThan(0); expect(css.length).toBeGreaterThan(0)
  const styles = readFileSync(new URL('../src/renderer/src/styles/index.css', import.meta.url), 'utf8'); expect(styles.length).toBeGreaterThan(0)
  expect(styles).toContain("@import './goals.css'")
  const match = css.match(/\.goals-board \{([^}]+)\}/); expect(match).not.toBeNull(); expect(match![1]).toContain('display: flex'); expect(match![1]).not.toContain('wrap')
  expect(source).not.toContain('SessionPane'); expect(source).not.toContain('AgentTopologySummary')
})
