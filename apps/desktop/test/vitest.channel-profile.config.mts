import { defineConfig } from 'vitest/config'
import base from './vitest.activity-current-signatures.config.mts'
import { resolve, relative, isAbsolute } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { candidateModule } from '../scripts/candidate-package-resolve.mjs'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_CHANNEL_PROFILE_MUTANT
const marker = process.env.AGENTMUX_CHANNEL_PROFILE_LOADED
const changes: Record<string, { path: string; before: string; after: string }> = {
  'drop-quote-summary': { path: 'packages/client-ui/src/components/InputChannelSummary.tsx', before: 'const quote = original?.message?.channelQuote', after: 'const quote = undefined' },
  'compare-author-grants': { path: 'packages/core/src/session-inputs.ts', before: "author.kind === 'external' ? externalConversationAuthor(author) : author,\n        known.kind === 'external' ? externalConversationAuthor(known) : known", after: 'author, known' },
  'disconnect-speaker': { path: 'apps/desktop/src/renderer/src/components/ActivityView.tsx', before: 'lookupExternal: author => channelProfiles.get(channelProfileKey(author))', after: 'lookupExternal: () => undefined' },
  'disconnect-mailbox-speaker': { path: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', before: 'lookupExternal: author => channelProfiles.get(channelProfileKey(author))', after: 'lookupExternal: () => undefined' },
  'omit-desktop-row-avatar': { path: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', before: 'url={described?.channelProfile?.profile?.avatarUrl} size={18}', after: 'size={18}' },
  'omit-shared-row-avatar': { path: 'packages/client-ui/src/components/InputMailboxRecords.tsx', before: 'url={described?.channelProfile?.profile?.avatarUrl} size={18}', after: 'size={18}' },
  'trust-foreign-route': { path: 'apps/desktop/src/renderer/src/lib/use-channel-actor-profiles.ts', before: 'owner?.hostId === localHostId && owner.sourceHostId === localHostId', after: 'owner?.sourceHostId === localHostId' },
  'trust-foreign-source': { path: 'apps/desktop/src/renderer/src/lib/use-channel-actor-profiles.ts', before: 'owner?.hostId === localHostId && owner.sourceHostId === localHostId', after: 'owner?.hostId === localHostId' },
  'reset-represented-profiles': { path: 'apps/desktop/src/renderer/src/lib/use-connector-room-name.ts', before: 'setRead(retain)', after: 'setRead(new Map())' },
  'released-watch-state': { path: 'apps/desktop/src/renderer/src/lib/use-connector-room-name.ts', before: '}, state => {\n          if (!live) return', after: '}, state => {' },
  'disconnect-notification': { path: 'apps/desktop/src/main/connector-ipc.ts', before: 'options.metadata.publish(watchId, event.data)', after: 'void event.data' },
  'omit-exact-clear': { path: 'apps/desktop/src/renderer/src/components/settings/ChannelMetadataPanel.tsx', before: "await connections.call('connection.metadata.clear', { ...input, expectedCacheRevision: entry.cacheRevision })", after: '{ entry }' }
}
if (mutation && !changes[mutation]) throw Error('Unknown Channel profile mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/channel-profile-consumer'),
  // UI browser sources have explicit aliases; native Main and SDK dependencies retain Node conditions.
  resolve: { ...base.resolve, conditions: ['node', 'import', 'default'], alias: [...base.resolve!.alias as [], { find: /^@noble\/hashes\/(.+)$/u, replacement: resolve(root, 'packages/core/node_modules/@noble/hashes/$1') }] },
  ssr: { ...base.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  plugins: [...base.plugins!, { name: 'channel-profile-loaded-owner', enforce: 'pre', transform(original, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    const kind = !query && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'module' : 'resource'
    let source = original
    const change = mutation ? changes[mutation] : undefined
    if (change?.path === path && kind === 'module') { if (source.split(change.before).length !== 2) throw Error('Channel profile mutation owner changed'); source = source.replace(change.before, change.after) }
    const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
    if (marker) {
      const raw = readFileSync(actual)
      // Vite reads the external tsc source map before transform hooks and blanks
      // its original URL comment. The proof checks that exact loader operation.
      const sourceMap = kind === 'module' && /\/dist\/.*\.js$/u.test(path) && sha(raw) !== sha(original)
        ? { path: path + '.map', sha256: sha(readFileSync(actual + '.map')) } : null
      appendFileSync(marker, JSON.stringify({ path, query, kind, fileSHA256: sha(raw), sourceMap,
        originalSHA256: sha(original), loadedSHA256: sha(source), mutation: source === original ? null : mutation }) + '\n')
    }
    return source === original ? undefined : { code: source, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/channel-profile-consumer.test.tsx'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 20_000 } })
