import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.mote-context.config.mts'

const root = owning.root!
const stable = 'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx'
const lateCapture = `const ranges = crossDocument ? captureReadingRanges(host) : []
        const activeElement = crossDocument ? oldDocument.activeElement : null
        const scrolls = crossDocument ? captureReadingScrolls(host, ranges, activeElement) : []`
const changes = {
  'restore-unused-capture': `const ranges = captureReadingRanges(host)
        const activeElement = oldDocument.activeElement
        const scrolls = captureReadingScrolls(host, ranges, activeElement)`,
  'omit-adoption-capture': `const ranges: ReadingRange[] = []
        const activeElement = oldDocument.activeElement
        const scrolls: ReadingScroll[] = []`
} as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...owning,
  cacheDir: resolve(root, '.tmp/stable-workbench-reading', process.env.AGENTMUX_READING_MUTANT ?? 'candidate'),
  plugins: [...(owning.plugins ?? []), { name: 'actual-late-reading-capture', enforce: 'pre', transform(original, id) {
    if (relative(root, id.split('?')[0]!) !== stable) return
    let code = original
    const mutant = process.env.AGENTMUX_READING_MUTANT as keyof typeof changes | undefined
    if (mutant) {
      assert.ok(Object.hasOwn(changes, mutant), 'Declared actual reading capture mutation')
      assert.equal(code.split(lateCapture).length - 1, 1, 'Unique actual attach capture branch')
      code = code.replace(lateCapture, changes[mutant])
    }
    if (process.env.AGENTMUX_READING_LOADED) appendFileSync(process.env.AGENTMUX_READING_LOADED,
      JSON.stringify({ path: stable, sourceSHA256: hash(original), loadedSHA256: hash(code), mutant: mutant ?? null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...owning.test, include: ['apps/desktop/test/stable-workbench-reading-transition.test.tsx'],
    setupFiles: [], globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
