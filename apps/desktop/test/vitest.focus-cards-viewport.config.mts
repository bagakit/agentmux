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
      assert.ok(['eager', 'forget-visited', 'no-initial-scan', 'queued-hidden', 'pointer-focus-replace', 'initial-columns'].includes(mutant))
      const inverses: Record<string, [string, string]> = {
        eager: ['const full = visited.current.has(contextKey(context))', 'const full = true'],
        'forget-visited': ['return () => { active = false; observer.disconnect() }', 'return () => { active = false; observer.disconnect(); visited.current.clear() }'],
        'no-initial-scan': ['for (const slot of slots) {', 'for (const slot of [] as HTMLDivElement[]) {'],
        'queued-hidden': ['if (!active) return', 'if (false) return'],
        'pointer-focus-replace': ['onMouseDown={event => { if (event.button === 0) event.preventDefault() }}', ''],
        'initial-columns': ["if (!layoutReady && rows && rows.clientWidth > 0 && rows.clientHeight > 0\n      && typeof ResizeObserver !== 'undefined' && typeof IntersectionObserver !== 'undefined') return", '']
      }
      const [from, to] = inverses[mutant]!
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
