import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const owner = 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
const cssOwner = 'apps/desktop/src/renderer/src/styles/focus-timeline-ruler.css'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/focus-timeline-measurement-vitest-cache'),
  plugins: [{ name: 'actual-timeline-measurement-owner', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (path !== owner && path !== cssOwner) return
    // The fixture installs this production stylesheet through its raw import.
    // Invert that consumed module once; ignore the regular CSS import.
    if (path === cssOwner && !id.includes('?raw')) return
    let code = path === owner && process.env.AGENTMUX_TIMELINE_MEASUREMENT_SOURCE ? readFileSync(process.env.AGENTMUX_TIMELINE_MEASUREMENT_SOURCE, 'utf8') : original
    const effective = code, mutant = process.env.AGENTMUX_TIMELINE_MEASUREMENT_MUTANT
    if (mutant) {
      assert(['name-inactive', 'ruler-inactive', 'queued-inactive', 'ruler-queued', 'ruler-rects', 'fixed-label-width', 'css-offset-owner', 'initial-empty', 'clock-initial-refresh'].includes(mutant), 'Known timeline measurement inverse')
      const replace = (from: string, to: string) => { assert.equal(code.split(from).length - 1, 1, 'Unique loaded ruler inverse'); code = code.replace(from, to) }
      if (mutant === 'css-offset-owner') {
        if (path === cssOwner) replace('translateX(var(--focus-label-offset, -50%))', 'translateX(-50%)')
      } else if (path === cssOwner) {
        // Other inverses change the actual TSX owner, leaving its original CSS.
      } else if (mutant === 'clock-initial-refresh') {
        replace('if (refresh) setNow(Date.now())', 'setNow(Date.now())')
      } else if (mutant === 'initial-empty') {
        replace('scaleWidth > 0 ? focusRulerLabels(ticks, range, scaleWidth) : new Set(ticks.map(tick => tick.instant))', 'focusRulerLabels(ticks, range, scaleWidth)')
      } else if (mutant === 'ruler-rects') {
        replace('const tick = node.parentElement!, labelWidth = widths.get(node) ?? 0', 'const tick = node.parentElement!, labelWidth = node.getBoundingClientRect().width')
        replace('const left = Math.max(0, Math.min(width - labelWidth, tickX - labelWidth / 2))', 'const left = node.getBoundingClientRect().left - scale.getBoundingClientRect().left')
      } else if (mutant === 'fixed-label-width') {
        replace('const tick = node.parentElement!, labelWidth = widths.get(node) ?? 0', 'const tick = node.parentElement!, labelWidth = 90')
      } else if (mutant === 'queued-inactive' || mutant === 'ruler-queued') {
        const anchor = 'return () => { active = false; observer.disconnect() }'
        assert.equal(code.split(anchor).length - 1, 2, 'Both actual measurement cleanup owners')
        if (mutant === 'queued-inactive') code = code.replaceAll(anchor, 'return () => observer.disconnect()')
        else { const at = code.lastIndexOf(anchor); code = code.slice(0, at) + code.slice(at).replace(anchor, 'return () => observer.disconnect()') }
      } else {
        const anchor = mutant === 'name-inactive'
          ? "    if (!documentVisible || mode === 'collapsed') return\n    const timeline = timelineRef.current"
          : "    if (!documentVisible || mode === 'collapsed') return\n    const scale = viewportRef.current?.querySelector<HTMLElement>('.recent-focus__time-scale')"
        assert.equal(code.split(anchor).length - 1, 1, 'Unique loaded measurement inverse')
        code = code.replace(anchor, anchor.slice(anchor.indexOf('\n') + 1))
      }
      if (code !== effective) process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    if (process.env.AGENTMUX_TIMELINE_MEASUREMENT_LOADED) appendFileSync(process.env.AGENTMUX_TIMELINE_MEASUREMENT_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(effective), loadedSHA256: hash(code), mutant: code !== effective ? mutant : null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: process.env.AGENTMUX_TIMELINE_MEASUREMENT_ADJACENT
    ? ['apps/desktop/test/focus-timeline-name-width.test.tsx'] : ['apps/desktop/test/focus-timeline-measurement.test.tsx'],
    css: { include: [/focus-timeline-ruler\.css/u] },
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
