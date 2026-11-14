import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  identity: ['packages/connectors/src/adapters/telegram/client.ts', 'user.is_bot !== true || telegramId(user.id) !== config.application.appId', 'false'],
  proof: ['packages/connectors/src/adapters/telegram/index.ts', '!this.witnesses.has(witness) || ', ''],
  custody: ['packages/connectors/src/adapters/telegram/index.ts', 'await input.receive({ raw, transportProof: witness }, acknowledge)', 'acknowledge(); await input.receive({ raw, transportProof: witness }, async () => {})'],
  boundary: ['packages/connectors/src/adapters/telegram/index.ts', 'sourceBoundaryUnconfirmed: !live', 'sourceBoundaryUnconfirmed: false'],
  sharing: ['packages/connectors/src/durable-ingress.ts', 'event.sourceBoundaryUnconfirmed ? null : this.freezeGroup(current.config.application, event.externalConversationId)', 'this.freezeGroup(current.config.application, event.externalConversationId)'],
  facts: ['packages/connectors/src/durable-ingress.ts', 'JSON.stringify(nativeEventFacts(event))', 'JSON.stringify(event)'],
  page: ['packages/connectors/src/adapters/telegram/client.ts', "method === 'getUpdates'", 'false'],
  credentials: ['packages/connectors/src/adapters/telegram/api.ts', '|getManagedBotToken|replaceManagedBotToken', ''],
  recipient: ['packages/connectors/src/adapters/telegram/publication.ts', 'chat_id: target.chatId', "chat_id: '-999'"]
}
const mutation = process.env.TELEGRAM_MUTANT, selected = mutation ? mutations[mutation] : undefined
if (mutation && !selected) throw Error('Unknown Telegram mutation')
export default defineConfig({ root, plugins: [{ name: 'telegram-product-source', enforce: 'pre', resolveId(source, importer) {
  if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
  if (source.startsWith('@agentmux/core/')) {
    const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
    if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
  }
  if (!importer || !source.startsWith('.')) return
  const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
  if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
}, transform(original, id) {
  if (!selected || relative(root, id.split('?')[0]!) !== selected[0]) return
  if (original.split(selected[1]).length !== 2) throw Error('Telegram mutant anchor must be unique')
  return 'console.error(' + JSON.stringify('TELEGRAM_MUTANT_LOADED: ' + mutation) + ');\n' + original.replace(selected[1], selected[2])
} }], test: { include: selected ? [selected[0].endsWith('durable-ingress.ts') ? 'packages/connectors/test/durable-ingress.test.ts' : 'packages/connectors/test/telegram-channel.test.ts'] : ['packages/connectors/test/telegram-channel.test.ts', 'packages/connectors/test/durable-ingress.test.ts', 'packages/connectors/test/input-context-continuity-consumer.test.ts'], passWithNoTests: false, globalSetup: [], fileParallelism: false, testTimeout: 20000 } })
