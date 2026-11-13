import { expect, it } from 'vitest'
import { runReaderProbe } from './native-runner'

it('uses isolated source-bound parser processes and the actual reader UI', async () => {
  const report = await runReaderProbe()
  expect(report.failure, report.failure).toBeUndefined()
  expect(report.checks).toBeGreaterThanOrEqual(60)
  expect(Object.keys(report.formats)).toEqual(['epub','mobi','azw3','fb2','cbz','cbr','djvu'])
}, 90000)
