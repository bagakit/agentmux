import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'drop-channel-producer': ['packages/core/src/agent-message-render.ts', 'return `${header}\\n${envelope.body}\\n</${AMUX_PROTOCOL_DEFINITIONS.channel.tag}>`', 'return envelope.body'],
  'drop-channel-reader': ['packages/core/src/agent-message-render.ts', 'return parseChannel(text)', 'return null'],
  'drop-channel-snapshot': ['packages/core/src/agent-message-envelope.ts', '...(channelProfile ? { channelProfile } : {})', ''],
  'reformat-prepared-input': ['packages/core/src/client.ts', "const retainWire = frozen && (producer === 'message' || isDeepStrictEqual(frozen.message, authored))", 'const retainWire = false']
}
const selected = process.env.AGENTMUX_CHANNEL_PROTOCOL_MUTANT
if (selected && !mutations[selected]) throw Error('Unknown channel protocol mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/channel-protocol', selected ?? 'positive'), plugins: [{
  name: 'channel-protocol-original-consumer', enforce: 'pre',
  resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
      const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  },
  transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') && !path.startsWith('packages/connectors/src/')) return
    let code = source
    const mutation = selected ? mutations[selected]! : undefined
    if (mutation?.[0] === path) {
      if (source.split(mutation[1]).length !== 2) throw Error('Channel protocol mutation anchor missing or ambiguous: ' + selected)
      code = source.replace(mutation[1], mutation[2])
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_CHANNEL_PROTOCOL_LOADED) appendFileSync(process.env.AGENTMUX_CHANNEL_PROTOCOL_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), ...(source === code ? {} : { mutation: selected }) }) + '\n')
    return source === code ? undefined : { code, map: null }
  }
}], test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 20000,
  include: ['packages/core/test/channel-profile.test.ts', 'packages/core/test/channel-message.test.ts', 'packages/core/test/agent-message-render.test.ts', 'packages/core/test/amux-protocol-catalog.test.ts', 'packages/connectors/test/channel-input-consumer.test.ts'] } })
