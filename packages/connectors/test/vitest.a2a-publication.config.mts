import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export default defineConfig({ ...native, cacheDir: '.cache/a2a-publication', plugins: [...native.plugins!, { name: 'a2a-publication-consumer-proof', enforce: 'pre',
  transform(original, id) {
    const path = relative(native.root!, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/src\/.+\.ts$/u.test(path)) return
    let code = original
    if (process.env.A2A_PUBLICATION_MUTANT === 'original-disconnect' && path === 'packages/connectors/src/publication-host.ts') {
      const before = 'const originals = await this.originalMessages(binding, [unit], signal)'
      if (code.split(before).length !== 2) throw Error('Original message consumer mutation did not load exactly once')
      code = code.replace(before, 'const originals = new Map()')
    }
    if (process.env.A2A_PUBLICATION_MUTANT === 'start-cut-disconnect' && path === 'packages/connectors/src/publication-a2a.ts') {
      const before = 'return origin.sequence > cut.inputJournal.sequence'
      if (code.split(before).length !== 2) throw Error('Original input cut mutation did not load exactly once')
      code = code.replace(before, 'return true')
    }
    if (process.env.A2A_PUBLICATION_MUTANT === 'direct-disconnect' && path === 'packages/connectors/src/publication-a2a.ts') {
      const before = "notice ? notice.messageIds : [target.key.kind === 'message' ? target.key.messageId : '']"
      if (code.split(before).length !== 2) throw Error('Original direct consumer mutation did not load exactly once')
      code = code.replace(before, 'notice ? notice.messageIds : []')
    }
    if (process.env.A2A_PUBLICATION_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.A2A_PUBLICATION_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(code !== original ? { mutation: process.env.A2A_PUBLICATION_MUTANT } : {}) }) + '\n')
    }
    if (code !== original) return code
  }
}], test: { ...native.test, include: ['packages/connectors/test/direct-a2a-gap.test.ts', 'packages/core/test/message-read-origin.test.ts', 'packages/connectors/test/connection-services-owner.test.ts', 'packages/connectors/test/a2a-publication-consumer.test.ts', 'packages/connectors/test/ordinary-conversation-publication.test.ts', 'packages/connectors/test/publication-a2a-boundary.test.ts'], testTimeout: 30_000 } })
