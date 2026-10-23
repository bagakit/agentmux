import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_CHANNEL_METADATA_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'omit-native-application': { path: 'packages/connectors/src/channel-storage.ts', before: 'key(scope.application.appId)', after: "'shared-native-application'" },
  'disconnect-native-refresh': { path: 'packages/connectors/src/adapters/feishu/channel-profile.ts', before: "input.storage.put({ key, expectedRevision: original?.revision ?? null, value: { kind: 'json', value: observation } })", after: 'void observation' },
  'disconnect-native-rename': { path: 'packages/connectors/src/adapters/feishu/index.ts', before: "input.metadataChanged?.({ kind: 'conversation', externalConversationId: feishuIdentity(payload.event?.chat_id) })", after: 'void payload.event?.chat_id' },
  'disconnect-desktop-owner': { path: 'packages/connectors/src/connection-services.ts', before: 'get: async (input, context) => (await ensure()).connections.metadata.get(input, context)', after: "get: async () => { throw new AgentMuxError('Metadata owner disconnected', 'CONTROL_UNAVAILABLE') }" }
}
if (mutant && !mutations[mutant]) throw Error('Unknown channel metadata semantic mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/channel-metadata'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'channel-metadata-loaded-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('packages/connectors/src/') && path !== 'packages/connectors/src/connection-services.ts') || !path.endsWith('.ts')) return
    const selected = mutant ? mutations[mutant]! : undefined, before = source
    if (selected?.path === path) {
      if (source.split(selected.before).length !== 2) throw Error('Channel metadata source mutation anchor changed: ' + mutant)
      source = source.replace(selected.before, selected.after)
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_CHANNEL_METADATA_LOADED) appendFileSync(process.env.AGENTMUX_CHANNEL_METADATA_LOADED, JSON.stringify({ path, originalSHA256: sha(before), loadedSHA256: sha(source), mutation: before === source ? null : mutant }) + '\n')
    return before === source ? undefined : { code: source, map: null }
  } }], test: { ...original.test, fileParallelism: false, passWithNoTests: false, include: ['packages/connectors/test/channel-metadata-consumer.test.ts'] }
})
