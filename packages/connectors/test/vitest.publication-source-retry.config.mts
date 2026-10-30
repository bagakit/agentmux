import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import publication from './vitest.publication-isolation.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'consume-latest-source': ['packages/connectors/src/publication-store.ts', 'const source = parseConnectionDeliveryRetrySource(input.source)', 'const source = this.retrySource(this.inspect(input.operationId)!) ?? parseConnectionDeliveryRetrySource(input.source)'],
  'late-upload-rollback': ['packages/connectors/src/publication-store.ts', "const retainedPending = accepted !== undefined && original.state === 'pending'", 'const retainedPending = false'],
  'public-source-reselection': ['packages/core/src/public-rpc-service.ts', 'owner.delivery!.retry(request,', 'owner.delivery!.retry({ ...request, source: original.delivery.retrySource ?? request.source },'],
  'ignore-current-authority': ['packages/connectors/src/publication-store.ts', "if (!authorized()) throw new AgentMuxError('This exact Binding no longer authorizes dispatch.'", "if (false && !authorized()) throw new AgentMuxError('This exact Binding no longer authorizes dispatch.'"]
} as const
const selected = process.env.PUBLICATION_SOURCE_RETRY_MUTATION as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown source continuation mutation')
export default defineConfig({ ...publication, cacheDir: resolve(root, '.cache/publication-source-retry'),
  plugins: [...publication.plugins!, { name: 'evaluated-publication-source-owner', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!), mutation = selected && mutations[selected]
    let code = original
    if (mutation && mutation[0] === file) {
      if (original.split(mutation[1]).length !== 2) throw Error('Source continuation mutation boundary changed')
      code = original.replace(mutation[1], mutation[2])
    }
    const marker = process.env.PUBLICATION_SOURCE_RETRY_LOADED
    if (marker && ['packages/connectors/src/publication-store.ts', 'packages/connectors/src/publication-host.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/connection-delivery-codec.ts', 'packages/core/src/agentmux-cli-commands.ts'].includes(file)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { file, originalSHA256: hash(original), loadedSHA256: hash(code), mutation: code === original ? null : selected }
      return { code: "import { appendFileSync as __sourceRetryLoaded } from 'node:fs'; __sourceRetryLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
    }
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...publication.test, include: ['packages/connectors/test/publication-source-retry-consumer.test.ts', 'packages/core/test/connection-delivery-codec.test.ts', 'packages/core/test/connection-delivery-public-consumer.test.ts'], passWithNoTests: false } })
