import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  ...source, root, cacheDir: resolve(root, '.tmp/session-frontend-diagnostic/vite-cache'),
  plugins: [...(source.plugins ?? []), { name: 'original-diagnostic-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'apps/desktop/src/renderer/src/components/SessionPane.tsx') return
    const original = code
    if (process.env.AGENTMUX_DIAGNOSTIC_MUTATION === 'fold-original-diagnostic') {
      const visible = 'supplement={<>{frontendDiagnostic}{identityNotice}', hidden = 'content: <><dl>'
      if (code.split(visible).length !== 2 || code.split(hidden).length !== 2) throw new Error('Original diagnostic rollback requires two unique owner sites.')
      code = code.replace(visible, 'supplement={<>{identityNotice}').replace(hidden, 'content: <>{frontendDiagnostic}<dl>')
    } else if (process.env.AGENTMUX_DIAGNOSTIC_MUTATION) throw new Error('Unknown diagnostic mutation')
    if (process.env.AGENTMUX_DIAGNOSTIC_LOADED) appendFileSync(process.env.AGENTMUX_DIAGNOSTIC_LOADED,
      JSON.stringify({ path, mutation: process.env.AGENTMUX_DIAGNOSTIC_MUTATION ?? null,
        originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/session-frontend-failure-surface.test.tsx', 'apps/desktop/test/session-startup-service-window.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
