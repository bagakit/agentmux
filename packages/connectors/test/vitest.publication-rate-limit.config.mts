import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.user-cards.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.PUBLICATION_RATE_LIMIT_MUTANT
const changes = {
  source: ['packages/connectors/src/publication-store.ts', 'const source = parseConnectionDeliveryRetrySource(input.source)', 'const source = this.retrySource(this.inspect(input.operationId)!) ?? parseConnectionDeliveryRetrySource(input.source)'],
  scope: ['packages/connectors/src/adapters/feishu/publication.ts', "['feishu', 'message-send', target.application.domain, target.externalConversationId]", "['feishu', 'message-send', target.application.domain, target.application.appId, target.externalConversationId]"],
  deadline: ['packages/connectors/src/publication-store.ts', 'if ((this.rateLimitCooling(scopes)?.notBefore ?? 0) > Date.now())', 'if (false)']
} as const
if (mutation && !(mutation in changes)) throw Error('Unknown original publication rate-limit mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/publication-rate-limit'),
  plugins: [...original.plugins!, { name: 'loaded-publication-rate-limit-owner', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!), selected = mutation && changes[mutation as keyof typeof changes]
    let output = input
    if (selected && selected[0] === file) {
      if (input.split(selected[1]).length !== 2) throw Error('Original rate-limit mutation boundary changed')
      output = input.replace(selected[1], selected[2])
    }
    const marker = process.env.PUBLICATION_RATE_LIMIT_LOADED
    if (marker && ['packages/connectors/src/publication-store.ts', 'packages/connectors/src/publication-host.ts', 'packages/connectors/src/adapters/feishu/publication.ts', 'packages/core/src/connection-delivery-codec.ts'].includes(file)) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: output === input ? null : mutation }
      return { code: "import {appendFileSync as __rateLimitLoaded} from 'node:fs'; __rateLimitLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output, map: null }
    }
    return input === output ? undefined : { code: output, map: null }
  } }], test: { ...original.test,
    include: ['packages/connectors/test/publication-rate-limit-consumer.test.ts', 'packages/connectors/test/publication-rate-limit-contract.test.ts', 'packages/connectors/test/publication-rate-limit-seek.test.ts'],
    globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 45_000 }
})
