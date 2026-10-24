import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_TEST_DELIVERY_ORDER_MUTATION
if (mutation && mutation !== 'oldest-diagnosis') throw Error('Unknown delivery order mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/delivery-order'), plugins: [{ name: 'actual-delivery-order-owner', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!/^packages\/(core\/dist|connectors\/src)\//u.test(path)) return
  let code = source
  if (mutation && path === 'packages/core/dist/connection-diagnosis.js') {
    const anchor = "order: 'newest'"
    if (source.split(anchor).length !== 2) throw Error('Original diagnosis order seam missing')
    code = source.replace(anchor, "order: 'oldest'")
  }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  if (process.env.AGENTMUX_TEST_DELIVERY_ORDER_LOADED) appendFileSync(process.env.AGENTMUX_TEST_DELIVERY_ORDER_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : mutation }) + '\n')
  return code === source ? undefined : { code, map: null }
} }], test: { ...original.test, include: ['packages/connectors/test/publication-worker-consumer.test.ts'], testNamePattern: 'recent delivery ordering', fileParallelism: false, passWithNoTests: false } })
