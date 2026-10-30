import base from '../../../apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { path: string; before: string; after: string }> = {
  qualification: { path: 'packages/client-ui/src/components/ConversationMessage.tsx',
    before: "isSystemContext && a2aNotificationId && contentBoundary === 'wire' && firstText !== undefined", after: 'firstText !== undefined' },
  'source-route': { path: 'apps/desktop/src/renderer/src/lib/mote-input-reader.ts', before: 'hostId: owner.routeHostId', after: 'hostId: owner.sourceHostId' },
  'input-status': { path: 'packages/client-ui/src/components/ConversationMoteNotice.tsx',
    before: "case 'terminal-confirmed': return '新输入已送入终端，是否采用待确认'", after: "case 'terminal-confirmed': return '成员已接收新输入'" },
  'eager-read': { path: 'packages/client-ui/src/components/ConversationMoteNotice.tsx', before: '!active || !open || !read || !target', after: '!active || !read || !target' },
  'inspection-match': { path: 'packages/core/src/mote-input-notice.ts', before: 'original.id === notice.observationId', after: 'true' }
}
const name = process.env.AGENTMUX_MOTE_NOTICE_MUTATION
if (name && !mutations[name]) throw Error('Unknown Mote notice mutation: ' + name)
export default defineConfig({ ...base,
  cacheDir: resolve(root, '.cache/mote-notice'),
  resolve: { ...base.resolve, alias: [...base.resolve!.alias as [],
    { find: /^@noble\/hashes\/(.+)$/u, replacement: resolve(root, 'packages/core/node_modules/@noble/hashes/$1') }] },
  plugins: [...base.plugins!, { name: 'loaded-mote-notice-production-mutation', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), mutation = name && mutations[name]
    const next = mutation && path === mutation.path ? code.replace(mutation.before, mutation.after) : code
    if (mutation && path === mutation.path && (next === code || code.split(mutation.before).length !== 2))
      throw Error('Mote notice mutation did not alter its exact loaded production branch: ' + name)
    if (process.env.AGENTMUX_MOTE_NOTICE_TRACE && (path.startsWith('packages/core/src/') || path.startsWith('packages/client-ui/src/') || path.endsWith('/mote-input-reader.ts')))
      appendFileSync(process.env.AGENTMUX_MOTE_NOTICE_TRACE, JSON.stringify({ path, mutation: next === code ? null : name,
        originalSHA256: createHash('sha256').update(code).digest('hex'), sha256: createHash('sha256').update(next).digest('hex') }) + '\n')
    return next === code ? undefined : { code: next, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: ['packages/client-ui/test/mote-notice.test.tsx',
    'packages/client-ui/test/a2a-original-reading.test.tsx', 'packages/client-ui/test/conversation-message-copy.test.tsx'], passWithNoTests: false }
})
