import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.publication-isolation.config.mts'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/input-adoption-growth'), plugins: [...base.plugins ?? [], {
  name: 'input-adoption-growth-evidence', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/conversation-reader.ts', 'packages/core/src/conversation-input-witness-index.ts', 'packages/core/src/conversation-stream.ts', 'packages/core/src/conversation-changes.ts', 'packages/connectors/src/publication-query-feedback.ts'].includes(path)) return
    let code = source
    const mutation = process.env.AGENTMUX_INPUT_GROWTH_MUTATION
    if (mutation && path === 'packages/core/src/conversation-input-witness-index.ts') {
      const replacements: Record<string, readonly [string, string]> = {
        'cumulative-overflow': ['return { witnesses, unconfirmedKeys }', 'return { witnesses, unconfirmedKeys, ...(this.records.size + (this.parent?.records.size ?? 0) > 1200 ? { unconfirmed: true as const } : {}) }'],
        'forget-turn-counterevidence': ["record.original.item.turnId && record.original.item.turnOutcome", "record.original.item.turnId && false"]
      }
      const replacement = replacements[mutation]
      if (!replacement || code.split(replacement[0]).length !== 2) throw Error('Missing unique original witness mutation')
      code = code.replace(...replacement)
    }
    const marker = process.env.AGENTMUX_INPUT_GROWTH_LOADED
    if (marker) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(marker, JSON.stringify({ path, source: hash(source), loaded: hash(code), ...(code !== source ? { mutation } : {}) }) + '\n')
    }
    return source === code ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/connectors/test/input-adoption-growth.test.ts'], testTimeout: 30_000 } })
