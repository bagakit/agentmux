import { defineConfig } from 'vitest/config'
import source from './conversation-process-detail.config.mts'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.CONVERSATION_DEFERRED_FOCUS_MUTANT
if (mutation && mutation !== 'mount-focus') throw Error('Unknown deferred focus mutation')
export default defineConfig({ ...source, cacheDir: resolve(root, '.cache/conversation-deferred-focus'), plugins: [...source.plugins!, {
  name: 'loaded-deferred-focus-owner', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['packages/client-ui/src/lib/use-conversation-record-layout.ts', 'packages/client-ui/src/components/ConversationView.tsx'].includes(file)) return
    let code = input
    if (mutation && file === 'packages/client-ui/src/lib/use-conversation-record-layout.ts') {
      const anchor = ' || prior?.mount !== next.mount'
      if (code.split(anchor).length !== 2) throw Error('Original deferred mount protection anchor missing or ambiguous')
      code = code.replace(anchor, '')
    }
    if (process.env.CONVERSATION_DEFERRED_FOCUS_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.CONVERSATION_DEFERRED_FOCUS_LOADED, JSON.stringify({ file, originalSHA256: sha(input), loadedSHA256: sha(code), mutation: code === input ? null : mutation }) + '\n')
    }
    return code === input ? undefined : { code, map: null }
  }
}], test: { ...source.test, include: ['packages/client-ui/test/conversation-process-detail.test.tsx', 'packages/client-ui/test/conversation-follow-policy.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, globalSetup: [] } })
