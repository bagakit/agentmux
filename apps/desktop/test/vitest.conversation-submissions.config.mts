import base from './vitest.conversation-unified-consumers.config.mts'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const file = 'packages/client-ui/src/components/CapturedConversationMessage.tsx'
const changes: Record<string, [string, string]> = {
  'lose-compact': ['const submission = Boolean(', 'const submission = false && Boolean('],
  'all-captured': ["record.role === 'message' && item.kind === 'user_message' && item.source === 'user'", 'true'],
  'lose-original': ['        {message}\n', '        {null}\n']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-submissions', plugins: [...base.plugins ?? [], {
  name: 'submission-source-qualification', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== file) return
    const mutation = process.env.AGENTMUX_SUBMISSION_MUTATION, change = mutation ? changes[mutation] : undefined
    if (mutation && (!change || source.split(change[0]).length !== 2)) throw Error('Missing unique submission mutation: ' + mutation)
    const code = change ? source.replace(change[0], change[1]) : source
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_SUBMISSION_LOADED) appendFileSync(process.env.AGENTMUX_SUBMISSION_LOADED, JSON.stringify({ path, mutation: mutation ?? null, originalSHA256: sha(source), sha256: sha(code) }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, css: { include: [/conversation-message(?:-disclosure)?\.css/u] },
  include: ['apps/desktop/test/conversation-submission-presentation.test.tsx', 'apps/desktop/test/conversation-source-labels.test.tsx', 'apps/desktop/test/conversation-submission-reader.test.tsx'], passWithNoTests: false } })
