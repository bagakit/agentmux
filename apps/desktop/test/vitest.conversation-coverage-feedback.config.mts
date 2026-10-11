import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-coverage-feedback', plugins: [...base.plugins ?? [], {
  name: 'conversation-coverage-feedback-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/client-ui/src/') && !path.startsWith('packages/core/src/')) return
    let code = source
    const mutation = process.env.AGENTMUX_COVERAGE_FEEDBACK_MUTATION
    if (mutation && ['invent-boundary-error', 'drop-automatic-error'].includes(mutation) && path === 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts') {
      const replacements: Record<string, [string, string]> = {
        'invent-boundary-error': ["const automaticReadError = intent.current === 'coverage' && view.errorOperation === 'older' ? view.error : null", "const automaticReadError = intent.current === 'coverage' ? view.error ?? (view.snapshot?.units.reduce((total, unit) => total + unit.records.length, 0) === 1200 || view.snapshot?.window.outside.newer ? Error('The selected time range exceeds this bounded reading window. Scroll earlier to continue.') : null) : null"],
        'drop-automatic-error': ["const automaticReadError = intent.current === 'coverage' && view.errorOperation === 'older' ? view.error : null", 'const automaticReadError = null']
      }
      const change = replacements[mutation]
      if (!change || source.split(change[0]).length !== 2) throw Error('Unknown or nonunique coverage feedback mutation: ' + mutation)
      code = source.replace(change[0], change[1])
    }
    if (mutation === 'clear-error-on-unrelated-changes' && path === 'packages/client-ui/src/lib/use-conversation-view.ts') {
      const needle = "...(sourceError || kind === 'latest' || kind === 'reopen' || value.errorOperation === kind ? { error: null, errorOperation: null } : {}),"
      if (source.split(needle).length !== 2) throw Error('Nonunique error settlement mutation')
      code = source.replace(needle, 'error: null, errorOperation: null,')
    }
    if (mutation === 'resurrect-normal-input-bar' && path === 'apps/desktop/src/renderer/src/components/ActivityView.tsx') {
      const needle = 'if (!needsService && (!showEarlier || !read.windowIncomplete && !read.hasMore)) return null'
      if (source.split(needle).length !== 2) throw Error('Nonunique normal input bar mutation')
      code = source.replace(needle, 'if (!needsService && !read.windowIncomplete && !(showEarlier && read.hasMore)) return null')
    }
    if (process.env.AGENTMUX_COVERAGE_FEEDBACK_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_COVERAGE_FEEDBACK_LOADED, JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code !== source ? { mutation } : {}) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-coverage-feedback.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 90000 } })
