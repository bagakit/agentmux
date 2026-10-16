import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const owner = 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/focus-timeline-measurement-vitest-cache'),
  plugins: [{ name: 'actual-timeline-measurement-owner', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (path !== owner) return
    let code = process.env.AGENTMUX_TIMELINE_MEASUREMENT_SOURCE ? readFileSync(process.env.AGENTMUX_TIMELINE_MEASUREMENT_SOURCE, 'utf8') : original
    const effective = code, mutant = process.env.AGENTMUX_TIMELINE_MEASUREMENT_MUTANT
    if (mutant) {
      assert(['name-inactive', 'ruler-inactive', 'queued-inactive'].includes(mutant), 'Known timeline measurement inverse')
      if (mutant === 'queued-inactive') {
        const anchor = 'return () => { active = false; observer.disconnect() }'
        assert.equal(code.split(anchor).length - 1, 2, 'Both actual measurement cleanup owners')
        code = code.replaceAll(anchor, 'return () => observer.disconnect()')
      } else {
        const anchor = mutant === 'name-inactive'
          ? "    if (!documentVisible || mode === 'collapsed') return\n    const timeline = timelineRef.current"
          : "    if (!documentVisible || mode === 'collapsed') return\n    const scale = viewportRef.current?.querySelector<HTMLElement>('.recent-focus__time-scale')"
        assert.equal(code.split(anchor).length - 1, 1, 'Unique loaded measurement inverse')
        code = code.replace(anchor, anchor.slice(anchor.indexOf('\n') + 1))
      }
      process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    if (process.env.AGENTMUX_TIMELINE_MEASUREMENT_LOADED) appendFileSync(process.env.AGENTMUX_TIMELINE_MEASUREMENT_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(effective), loadedSHA256: hash(code), mutant: mutant ?? null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: process.env.AGENTMUX_TIMELINE_MEASUREMENT_ADJACENT
    ? ['apps/desktop/test/focus-timeline-name-width.test.tsx'] : ['apps/desktop/test/focus-timeline-measurement.test.tsx'],
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
