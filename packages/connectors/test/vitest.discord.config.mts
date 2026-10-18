import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/discord-channel'), plugins: [{ name: 'native-discord-product-source', enforce: 'pre',
  transform(code, id) {
    const mutant = process.env.DISCORD_MUTANT
    const changes = {
      transport: ['adapters/discord/index.ts', 'await input.receive({ raw: witness.raw, transportProof: witness }, () => undefined)', 'await Promise.resolve()'],
      publication: ['adapters/discord/render.ts', ": '') + text", ": '') + 'Lost public reply'"],
      identity: ['adapters/discord/protocol.ts', 'userId: discordId(author.id)', 'userId: discordId(botId)'],
      resource: ['adapters/discord/publication.ts', 'data: Buffer.from(context.readResource(file))', 'data: Buffer.from("Changed original bytes")'],
      purpose: ['publication-content.ts', "if (item.kind === 'activity') return part.kind === 'resource'", "if (item.kind === 'activity') return false && part.kind === 'resource'"],
      question: ['adapters/discord/actions.ts', 'question.options[Number(value)]?.id', 'question.options[0]?.id'],
      permission: ['adapters/discord/render.ts', "custom_id: 'p:' + option.actionRef", "custom_id: 'p:missing-original-action'"],
      callback: ['adapters/discord/actions.ts', 'else input.callbackObservation?.(false)', 'else throw error'],
      long: ['adapters/discord/render.ts', 'if (content.length > 4000 &&', 'if (false && content.length > 4000 &&'],
      descriptor: ['publication-resource.ts', 'Object.keys(expected).some(key =>', "Object.keys(expected).filter(key => key !== 'resourceId').some(key =>"],
      hash: ['publication-resource.ts', 'Object.keys(expected).some(key =>', "Object.keys(expected).filter(key => key !== 'sha256').some(key =>"],
      length: ['publication-resource.ts', 'Object.keys(expected).some(key =>', "Object.keys(expected).filter(key => key !== 'byteLength').some(key =>"],
      source: ['publication-wire.ts', "file.source !== undefined && file.source !== 'public-interaction-text' ||", 'false ||'],
      reconnect: ['adapters/discord/index.ts', 'manager.on(WebSocketShardEvents.Closed, () => { receiver.socketFailed = true })', 'void 0'],
      guidance: ['adapters/discord/actions.ts', "question.acceptsText ? { description: 'Select one option", "false ? { description: 'Select one option"],
      feedback: ['adapters/discord/actions.ts', 'No answer was submitted.', 'The original action is unavailable.'],
      resume: ['adapters/discord/index.ts', 'const saved = readSession(id)', 'const saved = null'],
      'history-registration': ['platform-adapters.ts', 'readHistory: async (...input) => (await discord()).readHistory(...input)', 'readHistory: undefined'],
      'history-content': ['adapters/discord/history.ts', 'content: JSON.stringify(body)', "content: JSON.stringify({ content: 'Changed original native quote' })"]
    } as const
    const change = changes[mutant as keyof typeof changes]
    let loaded = code, mutation: string | undefined
    if (change && id.endsWith(change[0])) {
      if (code.split(change[1]).length !== 2) throw Error('The exact Discord mutant was not loaded once')
      process.stderr.write('DISCORD_LOADED_MUTANT:' + mutant + '\n')
      loaded = code.replace(change[1], change[2]); mutation = mutant
    }
    if (process.env.DISCORD_LOADED_SOURCE && /^packages\/(core|connectors)\/src\/.+\.ts$/u.test(id.slice(root.length + 1))) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.DISCORD_LOADED_SOURCE, JSON.stringify({ path: id.slice(root.length + 1), originalSHA256: sha(code), loadedSHA256: sha(loaded), ...(mutation ? { mutation } : {}) }) + '\n')
    }
    if (mutation) return loaded
  },
  resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
      const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }
}], test: { include: process.env.DISCORD_REGRESSION ? ['packages/connectors/test/recorded-image-publication-consumer.test.ts', 'packages/connectors/test/recorded-file-publication-consumer.test.ts'] : ['packages/connectors/test/discord-channel.test.ts'], environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
