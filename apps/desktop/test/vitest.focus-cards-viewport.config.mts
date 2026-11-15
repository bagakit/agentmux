import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const hash = (code: string) => createHash('sha256').update(code).digest('hex')
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/focus-cards-viewport-vitest-cache'),
  plugins: [{ name: 'actual-focus-card-body-source', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/components/FocusContextCards.tsx', 'apps/desktop/src/renderer/src/components/FocusContextRow.tsx'].includes(path)) return
    let code = original
    const mutant = process.env.AGENTMUX_FOCUS_CARDS_MUTANT
    if (path.endsWith('/FocusContextCards.tsx') && mutant) {
      const inverses: Record<string, [string, string]> = {
        eager: ['const full = visited.current.has(key) || requested', 'const full = true'],
        'forget-visited': ['observation.current = null', 'observation.current = null; visited.current.clear()'],
        'no-initial-scan': ['for (const slot of candidates) {', 'for (const slot of [] as CardSlot[]) {'],
        'queued-hidden': ['if (!visible) {\n      if (previous) {\n        stopObserving()', 'if (!visible) {\n      if (previous) {'],
        'queued-rejoin': ['entry.isIntersecting && current && entry.time >= current.observedAt', 'entry.isIntersecting && current'],
        'pointer-focus-replace': ['onMouseDown={event => { if (event.button === 0) event.preventDefault() }}', ''],
        'initial-columns': ["if (!layoutReady && observable && typeof window?.ResizeObserver !== 'undefined') return", ''],
        'scan-on-order': [
          'if (!changedViewport && !added.current.size) return',
          `if (!changedViewport && !added.current.size) {
            rows?.getBoundingClientRect()
            element.getBoundingClientRect()
            for (const slot of watching.current.keys()) slot.node.getBoundingClientRect()
            return
          }`
        ],
        'rebuild-on-order': [
          'if (!changedViewport && !added.current.size) return',
          `if (!changedViewport && !added.current.size) {
            if (rows) for (const slot of [...watching.current.keys()]) {
              unwatch(slot)
              watching.current.set(slot, viewport.observe(rows, viewportMargin, slot.node, () => {
                mount(slot.key)
                render()
              }))
            }
            return
          }`
        ]
      }
      const inverse = inverses[mutant]
      assert.ok(inverse, `Unknown Focus card mutation ${mutant}`)
      const [from, to] = inverse
      assert.equal(code.split(from).length - 1, 1, 'Actual unique body/retention owner')
      code = code.replace(from, to)
      process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    if (process.env.AGENTMUX_FOCUS_CARDS_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_CARDS_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), mutant: mutant ?? null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-cards-viewport.test.tsx'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
