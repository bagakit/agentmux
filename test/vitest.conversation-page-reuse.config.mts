import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../vitest.config.ts'

const root = resolve(import.meta.dirname, '..'), mutation = process.env.CONVERSATION_PAGE_REUSE_MUTATION
if (mutation && !['repeat-validation', 'skip-envelope'].includes(mutation)) throw Error('Unknown conversation page mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/conversation-page-reuse'), plugins: [{
  name: 'original-conversation-page-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core\/(src|dist|test)|connectors\/(src|test))\//u.test(path)) return
    let code = source
    if (mutation && /^packages\/core\/(src|dist)\/conversation-changes\.(ts|js)$/u.test(path)) {
      const read = /basePage\(\{ \.\.\.value \}, input, false, value\.items\)/gu
      const changes = /changesPage\(\{ \.\.\.value \}, input, value\.items\)/gu
      if (!read.test(source) || !changes.test(source)) throw Error('Original page reuse seam missing')
      code = mutation === 'repeat-validation'
        ? source.replace(read, 'basePage({ ...value }, input)').replace(changes, 'changesPage({ ...value }, input)')
        : source.replace(read, 'void 0').replace(changes, 'void 0')
    }
    if (process.env.CONVERSATION_PAGE_REUSE_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.CONVERSATION_PAGE_REUSE_LOADED, JSON.stringify({ path,
        originalSHA256: hash(source), loadedSHA256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...original.test, fileParallelism: false, passWithNoTests: false,
  include: ['packages/core/test/conversation-page-owner.test.ts', 'packages/connectors/test/publication-worker-consumer.test.ts'],
  testNamePattern: /^(reuses complete-unit|keeps original request|does not sanitize raw|owns only its original|validates complete fragment|publication reuses)/u
} })
