import base from './vitest.conversation-unified-consumers.config.mts'
import mobileBase from './vitest.conversation-mobile-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const activity = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const mobile = 'apps/mobile/src/conversation/MobileConversationSurface.tsx'
const layout = 'packages/client-ui/src/lib/use-conversation-record-layout.ts'
const owners = [activity, mobile, layout, 'packages/client-ui/src/lib/use-conversation-view.ts',
  'apps/desktop/src/renderer/src/lib/session-conversation-window.ts', 'apps/mobile/src/conversation/use-hosted-conversation.ts',
  'packages/core/src/conversation-reader.ts', 'packages/core/src/conversation-changes.ts']
const edits: Record<string, Array<[string, string, string]>> = {
  'identity-only-protection': [[layout, 'prior.version === next.version', 'true']]
}
export default defineConfig({ ...base, resolve: mobileBase.resolve, ssr: mobileBase.ssr,
  cacheDir: '.cache/conversation-captured-version', plugins: [...base.plugins ?? [], {
  name: 'captured-version-consumer-proof', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.includes(file)) return
    const mutation = process.env.AGENTMUX_CAPTURED_VERSION_MUTATION
    if (mutation && !edits[mutation]) throw new Error('Unknown captured version mutation')
    let code = source
    for (const [target, before, after] of mutation ? edits[mutation]! : []) if (file === target) {
      if (code.split(before).length !== 2) throw new Error('Captured version mutation must match exactly once')
      code = code.replace(before, after)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_CAPTURED_VERSION_LOADED) appendFileSync(process.env.AGENTMUX_CAPTURED_VERSION_LOADED,
      JSON.stringify({ path: file, originalSHA256: hash(source), sha256: hash(code), mutation: source === code ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-captured-version.test.tsx', 'apps/mobile/test/conversation-protocol-consumer.test.tsx'],
  testNamePattern: /selected captured version/, passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
