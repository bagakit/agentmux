import { defineConfig } from 'vitest/config'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'quote-escape': ['packages/core/src/channel-quote.ts', ".replace(/[<>&]/gu, char => ({ '<': '\\\\u003c', '>': '\\\\u003e', '&': '\\\\u0026' })[char]!)", ''],
  'quote-authority': ['packages/core/src/client.ts', '...(envelope.channelQuote === undefined ? {} : { channelQuote: structuredClone(envelope.channelQuote) }), ', ''],
  'quote-copy': ['packages/client-ui/src/components/InputMailboxRecords.tsx', '{ copyText: originalWire }', '{ copyText: item.message?.body ?? originalWire }'],
  'quote-rejoin-format': ['packages/core/src/client.ts', 'envelope.channelQuote ? source.promptWire! : renderAgentMuxMessageEnvelope(envelope)', 'renderAgentMuxMessageEnvelope(envelope)'],
  'quote-mailbox-field': ['packages/core/src/agent-input-mailbox-codec.ts', "'body', 'channelProfile', 'channelQuote'", "'body', 'channelProfile'"],
  'quote-reader': ['packages/core/src/agent-message-render.ts', 'declaredChannelQuote: { quote, raw: match[0].slice(0, -1) }', 'declaredChannelQuote: undefined'],
  'quote-host-authority': ['apps/host/src/external-input-authority.ts', '!isDeepStrictEqual(input.channelQuote, intent.channelQuote) || ', '']
}
const selected = process.env.AGENTMUX_QUOTE_MUTANT
if (selected && !mutations[selected]) throw Error('Unknown quote mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ root, cacheDir: resolve(root, '.cache/channel-quote', selected ?? 'positive'),
  plugins: [{ name: 'actual-channel-quote-source', enforce: 'pre',
    resolveId(source, importer) {
      const bare = /^@agentmux\/([^/]+)(?:\/(.+))?$/u.exec(source)
      if (bare) {
        const directory = resolve(root, 'packages', bare[1]!), manifest = resolve(directory, 'package.json')
        if (!existsSync(manifest)) return
        const key = bare[2] ? './' + bare[2] : '.', exports = JSON.parse(readFileSync(manifest, 'utf8')).exports
        let value = exports[key], match: string | undefined
        if (value === undefined) for (const candidate of Object.keys(exports).filter(key => key.includes('*')).sort((a, b) => b.length - a.length)) {
          const [before, after] = candidate.split('*')
          if (key.startsWith(before!) && key.endsWith(after!)) { value = exports[candidate]; match = key.slice(before!.length, after ? -after.length : undefined); break }
        }
        let path = typeof value === 'string' ? value : value?.browser ?? value?.import
        if (path) {
          if (match !== undefined) path = path.replace('*', match)
          path = path.replace(/^\.\/dist\//u, './src/').replace(/\.js$/u, '.ts')
          const target = resolve(directory, path)
          return existsSync(target) ? target : existsSync(target + 'x') ? target + 'x' : undefined
        }
      }
      if (!importer || !source.startsWith('.')) return
      const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
      if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^(?:packages\/(?:core|connectors|client-ui)\/src|apps\/host\/src)\/.+\.(?:ts|tsx)$/u.test(path)) return
      let code = original
      if (selected && mutations[selected]![0] === path) {
        const [, anchor, replacement] = mutations[selected]!
        if (code.split(anchor).length !== 2) throw Error('Quote mutation anchor missing or ambiguous: ' + selected)
        code = code.replace(anchor, replacement)
      }
      if (process.env.AGENTMUX_QUOTE_LOADED) appendFileSync(process.env.AGENTMUX_QUOTE_LOADED,
        JSON.stringify({ path, originalSHA256: hash(original), sha256: hash(code), ...(code === original ? {} : { mutation: selected }) }) + '\n')
      return code === original ? undefined : { code, map: null }
    }
  }],
  test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 20000,
    include: ['packages/core/test/channel-quote.test.ts', 'apps/desktop/test/channel-quote-input-consumer.test.tsx',
      'packages/core/test/channel-message.test.ts', 'packages/core/test/amux-protocol-catalog.test.ts'] }
})
