import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.channel-profile.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_PROFILE_FIELDS_MUTANT
const changes: Record<string, { path: string; before: string; after: string }> = {
  'omit-field-scope': { path: 'packages/connectors/src/adapters/feishu/setup-permissions.ts', before: "    { name: 'contact:user.base:readonly', group: 'identity' as const }", after: '' },
  'empty-is-current': { path: 'packages/connectors/src/adapters/feishu/channel-profile.ts', before: "else if (!user.name && !user.avatar?.avatar_240) observation = failure('not-visible')", after: "else if (false) observation = failure('not-visible')" },
  'drop-saved-fields': { path: 'packages/connectors/src/adapters/feishu/channel-profile.ts', before: "({ ...cached, state: 'unavailable', checkedAt: Date.now(), freshness: cached.profile ? 'stale' : 'unknown', reason })", after: "({ ...cached, profile: null, state: 'unavailable', checkedAt: Date.now(), freshness: 'unknown', reason })" },
  'empty-cache-current': { path: 'packages/connectors/src/adapters/feishu/channel-profile.ts', before: "if (observed.profile && !observed.profile.name && !observed.profile.avatarUrl)", after: 'if (false)' }
}
if (mutation && !changes[mutation]) throw Error('Unknown profile field mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/profile-field-permissions'),
  plugins: [...base.plugins!, { name: 'profile-fields-actual-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/') && !path.startsWith('apps/')) return
    if (path.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(path)) return
    let source = original
    const change = mutation ? changes[mutation] : undefined
    if (change?.path === path) {
      if (source.split(change.before).length !== 2) throw Error('Changed mutation anchor: ' + mutation)
      source = source.replace(change.before, change.after)
    }
    const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PROFILE_FIELDS_LOADED) appendFileSync(process.env.AGENTMUX_PROFILE_FIELDS_LOADED, JSON.stringify({ path,
      fileSHA256: sha(readFileSync(resolve(root, path))), originalSHA256: sha(original), loadedSHA256: sha(source), mutation: source === original ? null : mutation }) + '\n')
    return source === original ? undefined : { code: source, map: null }
  } }],
  test: { ...base.test, environment: 'node', include: ['packages/connectors/test/connection-setup-permission-request-consumer.test.ts',
    'packages/connectors/test/channel-profile-fields-consumer.test.ts', 'apps/desktop/test/channel-profile-consumer.test.tsx',
    'packages/connectors/test/connection-setup-initial-consumer.test.ts', 'packages/connectors/test/feishu-query-feedback.test.ts',
    'packages/connectors/test/connection-enrollment-initial-consumer.test.ts'], passWithNoTests: false }
})
