import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'
const mutations = {
  'drop-native-group': ['packages/connectors/src/adapters/feishu/room-discovery.ts', 'observe(input.externalConversationId, p)', 'undefined'],
  'drop-native-recipient': ['packages/connectors/src/adapters/discord/rooms.ts', 'for (const user of channel.recipients) observe.actor(user)', 'for (const user of []) observe.actor(user)'],
  'drop-visible-missing': ['apps/desktop/src/renderer/src/lib/use-connector-room-name.ts', 'if (nativeOnMiss && missing) {', 'if (false && nativeOnMiss && missing) {'],
  'drop-image-reset': ['apps/desktop/src/renderer/src/components/ConnectorEntityIdentity.tsx', 'key={JSON.stringify([identityKey, profileRead?.observation?.checkedAt])}', 'key={identityKey}'],
  'drop-visible-refresh': ['apps/desktop/src/renderer/src/components/ConnectorRoomSelection.tsx', "await refreshConnectorProfile({ ...scopeOf(connection), subject: next.value }, hostingTarget)", 'await Promise.resolve()']
} as const
const mutant = process.env.CONNECTOR_PROFILE_MUTANT as keyof typeof mutations | undefined
if (mutant && !mutations[mutant]) throw Error('Unknown connector profile mutation')
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/connector-profile-observation'), plugins: [...base.plugins!, {
  name: 'connector-profile-loaded', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors|client-ui))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    const selected = mutant && mutations[mutant]
    let loaded = original
    if (selected && selected[0] === path) { if (original.split(selected[1]).length !== 2) throw Error('Profile mutation anchor changed: ' + path); loaded = original.replace(selected[1], selected[2]) }
    if (!process.env.CONNECTOR_PROFILE_LOADED) return original === loaded ? undefined : { code: loaded, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: original === loaded ? null : mutant }
    return { code: "import { appendFileSync as __profileLoaded } from 'node:fs'; __profileLoaded(" + JSON.stringify(process.env.CONNECTOR_PROFILE_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['packages/connectors/test/room-profile-observation.test.ts', 'apps/desktop/test/connector-profile-refresh.test.tsx', 'apps/desktop/test/application-member-access.test.tsx'], testNamePattern: undefined, passWithNoTests: false, fileParallelism: false } })
