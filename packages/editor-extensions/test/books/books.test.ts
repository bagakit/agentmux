import { beforeAll, describe, expect, it } from 'vitest'
import { runBookProbe, type BookReport } from './native-runner'

let report: BookReport
beforeAll(async () => { report = await runBookProbe() }, 60000)

describe('books in actual Chromium', () => {
  for (const [name, minimum] of [['epub', 10], ['epub-concurrent', 3], ['css-cycle', 3], ['overlap', 3], ['missing', 3], ['compressed', 4], ['security', 7], ['traversal', 2], ['mobi', 6], ['mobi-images', 5], ['kf8', 6], ['encrypted', 2], ['fb2', 7], ['cbz', 5], ['close', 3], ['inflight', 3]] as const) {
    it(name, () => {
      expect(report.actualBrowser).toContain('Electron')
      expect(report.results[name], 'the browser actually executed this case').toBeDefined()
      expect(report.results[name]!.failure, report.results[name]!.failure).toBeUndefined()
      expect(report.results[name]!.checks).toBeGreaterThanOrEqual(minimum)
    })
  }
})
