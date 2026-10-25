import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import publication from './vitest.publication-isolation.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.DELIVERY_RETRY_MUTANT
if (mutation && mutation !== 'enrollment_gate') throw Error('Unknown delivery retry mutation')
export default defineConfig({ ...publication, cacheDir: resolve(root, '.cache/delivery-retry'),
  plugins: [...publication.plugins!, { name: 'loaded-delivery-retry', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'packages/core/src/public-rpc-service.ts') return
    const anchor = "if (caller && method === 'connection.delivery.retry')"
    if (original.split(anchor).length !== 2) throw Error('Delivery retry source anchor missing or ambiguous')
    const code = mutation ? original.replace(anchor, "if (false && caller && method === 'connection.delivery.retry')") : original
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = process.env.DELIVERY_RETRY_LOADED
    if (marker) appendFileSync(marker, JSON.stringify({ path, mutation: mutation ?? null, originalSHA256: hash(original), loadedSHA256: hash(code) }) + '\n')
    return { code, map: null }
  }}],
  test: { ...publication.test, include: ['packages/connectors/test/recorded-image-publication-consumer.test.ts', 'packages/connectors/test/query-feedback-native.integration.test.ts'],
    testNamePattern: /bound Agent|possibly applied message|managed receipt readers|managed retry/, passWithNoTests: false }
})
