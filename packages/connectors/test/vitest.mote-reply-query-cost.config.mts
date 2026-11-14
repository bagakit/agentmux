import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.mote-chat.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOTE_REPLY_SQL_MUTANT
if (mutation && mutation !== 'old-inner-scan') throw Error('Unknown Mote reply query mutation')
export default defineConfig({ ...original, root,
  cacheDir: resolve(root, process.env.MOTE_REPLY_SQL_CACHE ?? '.cache/mote-reply-query-cost'),
  plugins: [{ name: 'original-mote-query-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(packages\/(core|connectors)\/(src|test)|apps\/host\/src)\/.+\.[cm]?tsx?$/u.test(path)) return
    let code = source
    if (mutation && path === 'packages/connectors/src/publication-store.ts') {
      const before = 'IN (SELECT MIN(ordinal) FROM connector_publication_operation INDEXED BY connector_publication_mote_reply WHERE ${moteReplyOpen}'
      if (code.split(before).length !== 2) throw Error('The unique original inner Mote query was not loaded')
      code = code.replace(before, 'IN (SELECT MIN(ordinal) FROM connector_publication_operation WHERE ${moteReplyOpen}')
    }
    if (process.env.MOTE_REPLY_SQL_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MOTE_REPLY_SQL_LOADED, JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(code), mutation: source === code ? null : mutation }) + '\n')
    }
    if (code !== source) return { code, map: null }
  } }, ...original.plugins!],
  test: { ...original.test, globalSetup: [], fileParallelism: false, maxWorkers: 1, passWithNoTests: false,
    include: ['packages/connectors/test/publication-mote-reply-query-cost.test.ts', 'packages/connectors/test/mote-creator-reply.integration.test.ts'],
    testNamePattern: '^(mote reply query |keeps an applied reply with lost ACK inspect-only)', testTimeout: 30_000 }
})
