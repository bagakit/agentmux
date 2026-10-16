import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const owner = 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/focus-lane-measurement-vitest-cache'),
  plugins: [{ name: 'actual-lane-measurement-owner', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (path !== owner) return
    let code = process.env.AGENTMUX_LANE_MEASUREMENT_SOURCE ? readFileSync(process.env.AGENTMUX_LANE_MEASUREMENT_SOURCE, 'utf8') : original
    const effective = code, mutant = process.env.AGENTMUX_LANE_MEASUREMENT_MUTANT
    const replace = (from: string, to: string) => { assert.equal(code.split(from).length - 1, 1, 'Unique actual lane measurement inverse'); code = code.replace(from, to) }
    if (mutant) {
      if (mutant === 'sync-geometry') {
        replace('const width = entries.find(entry => entry.target === rows)?.contentRect.width ?? 0', "const width = rows.clientWidth > 0 ? rows.querySelector<HTMLElement>('.focus-project-lanes__groups')?.getBoundingClientRect().width ?? 0 : 0")
        replace('    const observer = new ResizeObserver(measure)', '    measure([], {} as ResizeObserver)\n    const observer = new ResizeObserver(measure)')
      } else if (mutant === 'queued-hidden') {
        replace('return () => { active = false; observer.disconnect() }', 'return () => observer.disconnect()')
      } else if (mutant === 'zero-overwrite') {
        replace('      if (width <= 0) return', '')
      } else if (mutant === 'inactive-observer') {
        replace("if (!visible || !documentActive || !hasBoardCards || !rows || typeof ResizeObserver === 'undefined') return", "if (!documentActive || !hasBoardCards || !rows || typeof ResizeObserver === 'undefined') return")
      } else throw Error('Unknown lane measurement mutation: ' + mutant)
      process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    if (process.env.AGENTMUX_LANE_MEASUREMENT_LOADED) appendFileSync(process.env.AGENTMUX_LANE_MEASUREMENT_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(effective), loadedSHA256: hash(code), mutant: mutant ?? null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: process.env.AGENTMUX_LANE_MEASUREMENT_ADJACENT
    ? ['apps/desktop/test/focus-lane-height-balance.test.tsx', 'apps/desktop/test/focus-lane-content-density.test.tsx']
    : ['apps/desktop/test/focus-lane-measurement.test.tsx'],
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
