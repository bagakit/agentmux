import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/channel-history'), plugins: [{ name: 'native-history-loaded-source', enforce: 'pre',
  transform(code, id) {
    const changes = {
      'feishu-thread': ['adapters/feishu/history.ts', "await scan('thread', threadId)", 'await Promise.resolve()'],
      'feishu-page': ['adapters/feishu/history.ts', 'tokens.add(next); pageToken = next', "gap('mutant-truncated'); break"],
      'feishu-content': ['adapters/feishu/history.ts', 'contentType: message.msg_type, content,', "contentType: message.msg_type, content: 'Lost original content',"],
      'feishu-native-shape': ['adapters/feishu/history.ts', 'if (message.thread_id !== undefined && !text(message.thread_id))', 'if (false)'],
      'discord-content': ['adapters/discord/history.ts', 'content: JSON.stringify(body)', "content: 'Lost native body'"],
      'discord-access': ['adapters/discord/history.ts', 'if (!contentAccess)', 'if (false && !contentAccess)'],
      'discord-boundary': ['adapters/discord/history.ts', 'if (input.range.from.inclusive)', 'if (true)'],
      'discord-native-shape': ['adapters/discord/history.ts', "if (!Number.isSafeInteger(message.type) || typeof message.content !== 'string' || !Array.isArray(message.attachments) || !Array.isArray(message.embeds))", 'if (false)']
    } as const
    const change = changes[process.env.CHANNEL_HISTORY_MUTANT as keyof typeof changes]
    let loaded = code, mutation: string | undefined
    if (change && id.endsWith(change[0])) {
      if (code.split(change[1]).length !== 2) throw Error('Exact history mutant must load once')
      loaded = code.replace(change[1], change[2]); mutation = process.env.CHANNEL_HISTORY_MUTANT
    }
    if (process.env.CHANNEL_HISTORY_LOADED && /^packages\/(core|connectors)\/src\/.+\.ts$/u.test(id.slice(root.length + 1))) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.CHANNEL_HISTORY_LOADED, JSON.stringify({ path: id.slice(root.length + 1), originalSHA256: sha(code), loadedSHA256: sha(loaded), ...(mutation ? { mutation } : {}) }) + '\n')
    }
    if (mutation) return loaded
  },
  resolveId(source, importer) {
    if (source.startsWith('@agentmux/')) {
      const [name, ...parts] = source.slice('@agentmux/'.length).split('/')
      if (name === 'identity') return
      const manifest = JSON.parse(readFileSync(resolve(root, 'packages', name!, 'package.json'), 'utf8'))
      const entry = manifest.exports[parts.length ? './' + parts.join('/') : '.']?.import
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages', name!, 'src', entry.slice(7).replace(/^src\//u, '').replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }
}], test: { include: ['packages/connectors/test/channel-history-native.test.ts'], environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
