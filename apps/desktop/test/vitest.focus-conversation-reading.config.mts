import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export default defineConfig({ ...base, cacheDir: '.cache/focus-conversation-reading', plugins: [...base.plugins ?? [], {
  name: 'focus-conversation-reading-loaded-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/client-ui/src/')) return
    let code = source
    const mutation = process.env.AGENTMUX_FOCUS_READING_MUTATION
    if (mutation && path === 'apps/desktop/src/renderer/src/components/ActivityView.tsx') {
      const fullSurface: [string, string] = ['const fullReadFailure = Boolean(conversationReading && !hasReadContent && readingIssues.length)', 'const fullReadFailure = false']
      const replacements: Record<string, [string, string][]> = {
        'failure-without-full-surface': [fullSurface],
        // The full failure surface never draws the light, so the decoration branch is reachable only without it.
        'decorate-source-failure': [fullSurface, ['{!emptyReadFailed ? <div className="full-page-loading__light activity-feed__reading-light"', '{true ? <div className="full-page-loading__light activity-feed__reading-light"']],
        'ignore-hidden-reading-motion': [["style={{ animationPlayState: documentVisible ? undefined : 'paused' }}", 'style={{ animationPlayState: undefined }}']],
        'hide-retained-reading-feedback': [['pending={readPending && !earlierReadPending}', 'pending={false}']]
      }
      const changes = replacements[mutation]
      if (!changes) throw Error('Unknown Focus reading mutation: ' + mutation)
      for (const [from, to] of changes) {
        if (code.split(from).length !== 2) throw Error('Nonunique Focus reading mutation target: ' + mutation)
        code = code.replace(from, to)
      }
    }
    if (process.env.AGENTMUX_FOCUS_READING_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_FOCUS_READING_LOADED, JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code !== source ? { mutation } : {}) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/focus-conversation-reading.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
