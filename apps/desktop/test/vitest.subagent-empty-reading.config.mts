import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_EMPTY_REPORT_MUTATION
const cardPath = 'packages/client-ui/src/components/ConversationMessageCard.tsx'
const edits: Record<string, { path: string; before: string; after: string }> = {
  'empty-preview': { path: cardPath, before: '!open && (preview || hasResources)', after: '!open' },
  'hide-resource': { path: cardPath, before: '!open && (preview || hasResources)', after: '!open && preview' },
  'remove-path-details': { path: cardPath, before: `<dl className="log-turn__collaboration-participants">
          <div><dt>发送者</dt><dd><code>{collaboration.sender ?? '路径未记录'}</code></dd></div>
          {collaboration.recipient ? <div><dt>接收者</dt><dd><code>{collaboration.recipient}</code></dd></div> : null}
        </dl>`, after: '' },
  'parent-avatar': { path: 'packages/client-ui/src/components/ConversationMessage.tsx', before: 'avatar: nativeCollaboration ? null :', after: 'avatar:' }
}
if (mutation && !edits[mutation]) throw Error('Unknown empty report mutation')
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export default defineConfig({ ...base, cacheDir: resolve(root, '.local/subagent-empty-reading/cache-' + (mutation ?? 'baseline')),
  plugins: [...(base.plugins ?? []), { name: 'empty-report-source-proof', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
    let code = source
    if (mutation && file === resolve(root, edits[mutation]!.path)) {
      const { before, after } = edits[mutation]!
      if (source.split(before).length !== 2) throw Error('Mutation must match one production behavior')
      code = source.replace(before, after)
    }
    if (process.env.AGENTMUX_EMPTY_REPORT_LOADED) appendFileSync(process.env.AGENTMUX_EMPTY_REPORT_LOADED,
      JSON.stringify({ path: relative(root, file), original: hash(readFileSync(file)), mutated: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: ['packages/client-ui/test/conversation-collaboration.test.tsx'] }
})
