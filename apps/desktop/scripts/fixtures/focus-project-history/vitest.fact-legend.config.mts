import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.renderer-history.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
const changes: Record<string, readonly [string, string]> = {
  "legend-disconnected": [
    "<FocusTimelineLegend reading={nativeWindow.window} sources={inputSources.length} onRead={openInputRecords} />",
    "{null}"
  ],
  "alive-as-work": [
    "const work = working ? focusWorkSegment(context.workingEnteredAt, window, now) : null",
    "const work = context?.kind === 'agent' && context.processState === 'running' ? focusWorkSegment(context.workingEnteredAt ?? window.start, window, now) : null"
  ],
  "coverage-removed": [
    "<p>Other sources have not been read. Select one in Input records to add its real records to this window.</p>",
    "<p>All sources checked.</p>"
  ]
}
export default defineConfig({
  ...original,
  plugins: [...(original.plugins ?? []), {
    name: 'focus-fact-legend-loaded-source', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const before = code, mutation = process.env.AGENTMUX_FOCUS_FACT_LEGEND_MUTATION
      if (mutation && file === `${root}/apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx`) {
        const change = changes[mutation]
        if (!change) throw new Error(`Unknown mutation ${mutation}`)
        if (code.split(change[0]).length !== 2) throw new Error(`Missing unique loaded owner for ${mutation}`)
        code = code.replace(change[0], change[1])
      }
      const destination = process.env.AGENTMUX_FOCUS_FACT_LEGEND_LOADED_SOURCE
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== before ? { mutation } : {}) })}\n`)
      if (code !== before) return { code, map: null }
    }
  }],
  cacheDir: resolve(root, '.tmp/focus-timeline-fact-legend-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-timeline-fact-legend.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 }
})
