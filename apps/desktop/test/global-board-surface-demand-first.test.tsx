import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { allStyles, styleFiles } from './helpers/styles'
it('keeps Goals isolated from the shared Focus stylesheet and uses a single horizontal board track', () => {
  const source = readFileSync(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url), 'utf8')
  const css = allStyles()
  expect(source.length).toBeGreaterThan(0); expect(css.length).toBeGreaterThan(0)
  const styles = styleFiles().map(file => file.name); expect(styles.length).toBeGreaterThan(0)
  expect(styles).toContain('goals.css')
  const match = css.match(/\.goals-board \{([^}]+)\}/); expect(match).not.toBeNull(); expect(match![1]).toContain('display: flex'); expect(match![1]).not.toContain('wrap')
  expect(source).not.toContain('SessionPane'); expect(source).not.toContain('AgentTopologySummary')
})
