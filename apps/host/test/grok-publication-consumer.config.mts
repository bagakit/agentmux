import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mote-default-join-consumer.config.mts'
const mutation = process.env.T043_MUTANT
if (mutation && mutation !== 'disconnect-changes') throw Error('Unknown Grok mutation')
export default defineConfig({ ...original, plugins: [{ name: 'grok-publication-qualified-source', enforce: 'pre', transform(source, id) {
  const path = relative(original.root!, id.split('?')[0]!)
  if (!/^(?:packages\/(?:core|connectors)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(path)) return
  let loaded = source
  if (mutation && path === 'packages/core/src/providers/grok.ts') {
    const before = '    readConversationChanges: readGrokConversationChanges,'
    if (source.split(before).length !== 2) throw Error('Exact Grok changes registration must load once')
    loaded = source.replace(before, '')
  }
  if (process.env.T043_LOADED) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(source !== loaded ? { mutation } : {}) }
    loaded = `import { appendFileSync as __t043Loaded } from 'node:fs'; __t043Loaded(${JSON.stringify(process.env.T043_LOADED)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + loaded
  }
  return { code: loaded, map: null }
} }, ...original.plugins!], test: { ...original.test, include: [
  'apps/host/test/grok-publication-consumer.test.ts',
  'packages/core/test/providers/grok-session-analysis.test.ts',
  'packages/core/test/providers/grok-native-observation.test.ts',
  'packages/core/test/providers/grok-native-boundaries.test.ts',
  'packages/core/test/native-history-provider-projections.test.ts'
], testTimeout: 25_000 } })
