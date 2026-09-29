import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...base,
  root,
  plugins: [...(base.plugins ?? []), {
    name: 'actual-focus-message-author-consumer', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/.test(file)) return
      const original = code, mutation = process.env.AGENTMUX_FOCUS_AUTHOR_MUTATION
      const changes: Record<string, [string, string, string]> = {
        'unknown-as-human': ['components/FocusMessagePreview.tsx', 'const speaker = message ? speakerOfUserMessage(message) : undefined', "const actualSpeaker = message ? speakerOfUserMessage(message) : undefined; const speaker = actualSpeaker?.role === 'unknown' ? { role: 'human' as const, id: 'human' } : actualSpeaker"],
        'human-as-agent': ['components/RecentFocusTimeline.tsx', 'const speaker = speakerOfUserMessage(message)', "const actualSpeaker = speakerOfUserMessage(message); const speaker = actualSpeaker.role === 'human' ? { role: 'agent' as const, id: message.agentSessionId } : actualSpeaker"],
        'body-bypasses-speaker': ['components/FocusMessagePreview.tsx', 'speaker={speaker!}', "speaker={{ role: 'unknown', id: 'unknown' }}"]
      }
      if (mutation) {
        const change = changes[mutation]; if (!change) throw new Error(`Unknown author mutation ${mutation}`)
        if (file === `${root}/apps/desktop/src/renderer/src/${change[0]}`) {
          if (code.split(change[1]).length !== 2) throw new Error(`Missing unique loaded author mutation ${mutation}`)
          code = code.replace(change[1], change[2])
        }
      }
      const destination = process.env.AGENTMUX_FOCUS_AUTHOR_LOADED_SOURCE
      if (destination) appendFileSync(destination, JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== original ? { mutation } : {}) }) + '\n')
      if (code !== original) return { code, map: null }
    }
  }],
  cacheDir: resolve(root, '.tmp/focus-message-author-consumer-cache'),
  test: { ...base.test, include: ['apps/desktop/test/focus-message-author-consumer.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000, hookTimeout: 30_000 }
})
