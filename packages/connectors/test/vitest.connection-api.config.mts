import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.CONNECTION_API_HOST_MUTANT
const mutations = {
  'foreign-binding': { path: 'packages/connectors/src/connection-api.ts', before: "return context.actor.kind !== 'agent' || context.session?.agentSessionId === binding.agentSessionId && context.session.hostId === binding.executionHostId", after: 'return true' },
  'credential-output': { path: 'packages/connectors/src/connection-api.ts', before: 'const safe = redaction.sanitize(checked.response.body as unknown as ConnectionApiJson)', after: 'const safe = { value: checked.response.body, redacted: false }' }
}
if (mutation && !Object.hasOwn(mutations, mutation)) throw Error('Unknown native API Host mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/connection-api'), resolve: { alias: [
  { find: /^@agentmux\/core$/, replacement: resolve(root, 'packages/core/src/index.ts') },
  { find: /^@agentmux\/core\/(.+)$/, replacement: resolve(root, 'packages/core/src/$1.ts') }
] }, plugins: [{ name: 'original-native-api-owners', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!/^packages\/connectors\/(?:src|test)\//u.test(path) && !/^packages\/core\/src\/(?:public-rpc|connection-api|connections|room-binding)/u.test(path)) return
  let loaded = source
  const selected = mutation ? mutations[mutation as keyof typeof mutations] : undefined
  if (selected?.path === path) {
    if (source.split(selected.before).length !== 2) throw Error('Native API mutation needs the exact original owner anchor')
    loaded = source.replace(selected.before, selected.after)
  }
  if (process.env.CONNECTION_API_HOST_LOADED) {
    const sha = (v: string) => createHash('sha256').update(v).digest('hex')
    const row = { path, originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: selected?.path === path ? mutation : null }
    loaded = `import {appendFileSync as __nativeApiLoaded} from 'node:fs'; __nativeApiLoaded(${JSON.stringify(process.env.CONNECTION_API_HOST_LOADED)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + loaded
  }
  return { code: loaded, map: null }
} }], test: { passWithNoTests: false, fileParallelism: false, include: ['packages/connectors/test/connection-api-host.test.ts', 'packages/connectors/test/connection-api-consumer.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, testTimeout: 25_000 } })
