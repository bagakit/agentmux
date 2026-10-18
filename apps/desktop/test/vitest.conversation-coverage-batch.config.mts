import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-coverage-batch', plugins: [...base.plugins ?? [], {
  name: 'original-coverage-batch', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    const ahead = 'apps/desktop/src/renderer/src/lib/use-conversation-read-ahead.ts'
    if (path !== owner && path !== ahead && path !== 'packages/client-ui/src/lib/use-conversation-view.ts') return
    const mutation = process.env.AGENTMUX_COVERAGE_BATCH_MUTATION
    const edits: Record<string, [string, string]> = {
      'unbounded-batch': ['    coverageDemand.current.remaining--', '    void 0'],
      'repaint-refill': ['const coverageDemand = useRef({ key, duration: coverageDuration, remaining: 2 })', 'const coverageDemand = { current: { key, duration: coverageDuration, remaining: 2 } }'],
      'ignore-source-share': ['Math.max(1, sources)', '1'],
      'ignore-shrink': ['coverageDuration < previous.duration ? 0', 'coverageDuration < previous.duration ? previous.remaining'],
      'tiny-frozen-packets': ['...(cursor ? { cursor, limit: 100 } : {})', '...(cursor ? { cursor } : {})'],
      'ignore-request-limit': ["limit === undefined ? {} : { limit }", '{}'],
      'unbounded-read-ahead': ['direction, remaining: 3, waitingFor: null', 'direction, remaining: 30, waitingFor: null'],
      'drop-read-ahead-preservation': ['void view.earlier(limit, { preserveCurrent: true })', 'void view.earlier(limit)'],
      'ignore-opposite-demand': ['if (demand.current?.direction === direction) return', 'if (demand.current) return'],
      'retain-hidden-demand': [' || !input.active || input.stopped', ' || input.stopped']
    }
    if (mutation && !edits[mutation]) throw new Error('Unknown coverage batch mutation')
    let code = source
    const edit = mutation ? edits[mutation] : undefined
    const target = ['unbounded-read-ahead', 'ignore-opposite-demand', 'retain-hidden-demand'].includes(mutation ?? '') ? ahead
      : ['ignore-request-limit', 'tiny-frozen-packets'].includes(mutation ?? '') ? 'packages/client-ui/src/lib/use-conversation-view.ts' : owner
    if (edit && path === target) {
      if (source.split(edit[0]).length !== 2) throw new Error('Coverage batch mutation must match exactly once')
      code = source.replace(edit[0], edit[1])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_COVERAGE_BATCH_LOADED) appendFileSync(process.env.AGENTMUX_COVERAGE_BATCH_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), mutation: source === code ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-coverage-batch.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
