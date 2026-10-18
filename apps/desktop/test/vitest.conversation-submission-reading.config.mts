import base from './vitest.conversation-unified-consumers.config.mts'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, [string, string, string]> = {
  'unrelated-confirms': ['packages/client-ui/src/lib/conversation-sources.ts', "? originals.filter(source => source.original.kind", "? [...inventory.values()].filter(source => source.original.kind"],
  'retain-completed-activity': ['packages/client-ui/src/lib/use-conversation-view.ts', 'setState(value => ({ ...value, loading: false, operation: null, sourceRead: null }))', 'setState(value => ({ ...value, operation: null }))'],
  'unknown-range-fold': ['packages/client-ui/src/components/ConversationMessageDisclosure.tsx', '(controlledOpen ?? choice ?? (expanded || selected))', '(controlledOpen ?? choice ?? expanded)'],
  'held-accepted-coverage': ['packages/client-ui/src/lib/use-conversation-record-layout.ts', 'return { ...accepted.frame, sequence:', 'return { ...accepted.frame, coverage: (frame as any).coverage, sequence:'],
  'retained-latest-source': ['packages/client-ui/src/lib/use-conversation-view.ts', "kind === 'resume' ? undefined : request.nativeSource ??", "kind === 'resume' ? undefined : originalNative ?? request.nativeSource ??"],
  'lose-mobile-source-read': ['apps/mobile/src/conversation/MobileConversationSurface.tsx', 'readActivity={reading.readActivity}', 'readActivity={undefined}'],
  'lose-source-read': ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'readActivity={readingWindow.readActivity}', 'readActivity={undefined}']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-submission-reading', plugins: [...base.plugins ?? [], {
  name: 'actual-submission-reading', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    const mutation = process.env.AGENTMUX_SUBMISSION_READING_MUTATION, change = mutation ? changes[mutation] : undefined
    if (mutation && !change) throw Error('Unknown submission reading mutation')
    let code = source
    if (change && path === change[0]) {
      if (source.split(change[1]).length !== 2) throw Error('Missing unique submission reading mutation: ' + mutation)
      code = source.replace(change[1], change[2])
    }
    if (process.env.AGENTMUX_SUBMISSION_READING_LOADED && (path.startsWith('packages/client-ui/src/') || path.startsWith('apps/desktop/src/') || path.startsWith('apps/mobile/src/'))) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_SUBMISSION_READING_LOADED, JSON.stringify({ path, mutation: code !== source ? mutation : null, originalSHA256: hash(source), sha256: hash(code) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-submission-reading.test.tsx', 'packages/client-ui/test/conversation-presentation.test.tsx'], passWithNoTests: false } })
