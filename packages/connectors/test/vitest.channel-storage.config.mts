import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_CHANNEL_STORAGE_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'omit-native-application': { path: 'packages/connectors/src/channel-storage.ts', before: 'key(scope.application.appId)', after: "'shared-application'" },
  'accept-invalid-bytes': { path: 'packages/connectors/src/channel-storage.ts', before: "else throw Error('The original Channel value representation is unconfirmed')", after: "else value = { kind: 'bytes', value: new Uint8Array() }" },
  'disconnect-native-cache': { path: 'packages/connectors/src/adapters/feishu/channel-profile.ts', before: "input.storage.put({ key: storageKey, expectedRevision: original?.revision ?? null, value: { kind: 'json', value: observation } }); return observation", after: 'return observation' }
}
if (mutant && !mutations[mutant]) throw Error('Unknown Channel storage source mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/channel-storage'),
  plugins: [{ name: 'channel-storage-loaded-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/connectors/src/') || !path.endsWith('.ts')) return
    const selected = mutant ? mutations[mutant]! : undefined, before = source
    if (selected?.path === path) {
      if (source.split(selected.before).length !== 2) throw Error('Channel source mutation anchor changed: ' + mutant)
      source = source.replace(selected.before, selected.after)
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_CHANNEL_STORAGE_LOADED) appendFileSync(process.env.AGENTMUX_CHANNEL_STORAGE_LOADED, JSON.stringify({ path, originalSHA256: sha(before), loadedSHA256: sha(source), mutation: before === source ? null : mutant }) + '\n')
    return before === source ? undefined : { code: source, map: null }
  } }], test: { ...original.test, globalSetup: [], fileParallelism: false, passWithNoTests: false, include: ['packages/connectors/test/channel-storage-consumer.test.ts'] }
})
