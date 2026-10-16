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
      const replacements: Record<string, [string, string]> = {
        'failure-remains-pending': ['const emptyReadFailed = Boolean(readingWindow.error || readingWindow.automaticReadError || !readingWindow.historical && userMessageRead?.error)', 'const emptyReadFailed = false'],
        'decorate-source-failure': ['{!emptyReadFailed ? <div className="full-page-loading__light activity-feed__reading-light"', '{true ? <div className="full-page-loading__light activity-feed__reading-light"'],
        'ignore-hidden-reading-motion': ["style={{ animationPlayState: documentVisible ? undefined : 'paused' }}", 'style={{ animationPlayState: undefined }}'],
        'hide-retained-reading-feedback': ['pending={readPending && !earlierReadPending}', 'pending={false}']
      }
      const change = replacements[mutation]
      if (!change || source.split(change[0]).length !== 2) throw Error('Unknown or nonunique Focus reading mutation: ' + mutation)
      code = source.replace(change[0], change[1])
    }
    if (process.env.AGENTMUX_FOCUS_READING_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_FOCUS_READING_LOADED, JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code !== source ? { mutation } : {}) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/focus-conversation-reading.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
