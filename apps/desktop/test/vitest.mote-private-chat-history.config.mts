import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_MOTE_HISTORY_MUTATION
if (mutation && !['all-people', 'wrong-input-host'].includes(mutation)) throw Error('Unknown Mote history mutation')
const connectors = JSON.parse(readFileSync(resolve(root, 'packages/connectors/package.json'), 'utf8'))
const aliases = Object.entries(connectors.exports).map(([entry, value]) => ({
  find: '@agentmux/connectors' + (entry === '.' ? '' : entry.slice(1)),
  replacement: resolve(root, 'packages/connectors', (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
})).sort((a, b) => b.find.length - a.find.length)
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/mote-private-chat-history'),
  resolve: { ...base.resolve, alias: [...aliases, ...(base.resolve!.alias as [])] },
  plugins: [{ name: 'original-mote-history-consumer', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return
    const path = resolve(dirname(importer), source), match = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }, transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/')) return
    let code = source
    if (mutation && file === 'apps/desktop/src/renderer/src/components/MoteChatHistory.tsx') {
      const [from, to] = mutation === 'all-people' ? ["{ target, actor, ...(cursor ?", "{ target, ...(cursor ?"]
        : ['{ hostId, agentSessionId }, input)', "{ hostId: 'wrong-host', agentSessionId }, input)"]
      if (source.split(from!).length !== 2) throw Error('Missing unique actual Mote history consumer mutation')
      code = source.replace(from!, to!)
    }
    const log = process.env.AGENTMUX_MOTE_HISTORY_LOADED
    if (log) { const sha = (value: string) => createHash('sha256').update(value).digest('hex'); appendFileSync(log, JSON.stringify({ file, originalSHA256: sha(source), sha256: sha(code), mutation: code === source ? null : mutation }) + '\n') }
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/mote-private-chat-profile.test.tsx', 'apps/desktop/test/mote-private-chat-history.test.tsx'], testTimeout: 20000 }
})
