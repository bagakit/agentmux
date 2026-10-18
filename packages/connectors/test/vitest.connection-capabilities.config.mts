import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_CHANNEL_CAPABILITIES_MUTANT
if (mutant && mutant !== 'invent-room-creation') throw Error('Unknown original adapter capability mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/channel-capabilities'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'loaded-connection-capabilities', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'packages/connectors/src/connection-host.ts') return
    const before = source
    if (mutant) {
      const anchor = 'roomCreation: !!adapter.rooms'
      if (source.split(anchor).length !== 2) throw Error('Original adapter capability anchor changed')
      source = source.replace(anchor, 'roomCreation: true')
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_CHANNEL_CAPABILITIES_LOADED) appendFileSync(process.env.AGENTMUX_CHANNEL_CAPABILITIES_LOADED, JSON.stringify({ path, originalSHA256: sha(before), loadedSHA256: sha(source), mutation: before === source ? null : mutant }) + '\n')
    return before === source ? undefined : { code: source, map: null }
  } }], test: { ...original.test, passWithNoTests: false, include: ['packages/connectors/test/connection-capabilities-consumer.test.ts'] }
})
