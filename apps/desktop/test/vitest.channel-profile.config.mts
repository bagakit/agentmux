import { defineConfig } from 'vitest/config'
import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_CHANNEL_PROFILE_MUTANT
const changes: Record<string, { path: string; before: string; after: string }> = {
  'disconnect-speaker': { path: 'apps/desktop/src/renderer/src/components/SessionPane.tsx', before: 'lookupExternal: author => channelProfiles.get(channelProfileKey(author))', after: 'lookupExternal: () => undefined' },
  'disconnect-notification': { path: 'apps/desktop/src/main/connector-ipc.ts', before: 'options.metadata!.publish(change)', after: 'void change' },
  'omit-exact-clear': { path: 'apps/desktop/src/renderer/src/components/settings/ChannelMetadataPanel.tsx', before: "await api.connections.call('connection.metadata.clear', { ...input, expectedCacheRevision: entry.cacheRevision })", after: '{ entry }' }
}
if (mutation && !changes[mutation]) throw Error('Unknown Channel profile mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/channel-profile-consumer'),
  // UI browser sources have explicit aliases; native Main and SDK dependencies retain Node conditions.
  resolve: { ...base.resolve, conditions: ['node', 'import', 'default'], alias: [...base.resolve!.alias as [], { find: /^@noble\/hashes\/(.+)$/u, replacement: resolve(root, 'packages/core/node_modules/@noble/hashes/$1') }] },
  ssr: { ...base.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  plugins: [...base.plugins!, { name: 'channel-profile-loaded-owner', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!Object.values(changes).some(change => change.path === path)) return
    let source = original
    const change = mutation ? changes[mutation] : undefined
    if (change?.path === path) { if (source.split(change.before).length !== 2) throw Error('Channel profile mutation owner changed'); source = source.replace(change.before, change.after) }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const marker = process.env.AGENTMUX_CHANNEL_PROFILE_LOADED
    if (marker) {
      const row = JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(source), mutation: source === original ? null : mutation })
      source = "import { appendFileSync as __recordChannelProfileOwner } from 'node:fs'; __recordChannelProfileOwner(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + source
    }
    return source === original ? undefined : { code: source, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/channel-profile-consumer.test.tsx'] } })
