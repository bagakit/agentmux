import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export default defineConfig({ ...native, plugins: [...native.plugins!, { name: 'quote-selection-original-source', enforce: 'pre', transform(original, id) {
  const path = relative(native.root!, id.split('?')[0]!), mutant = process.env.QUOTE_SELECTION_MUTANT
  const variants: Record<string, { path: string; before: string; after: string; extra?: [string, string] }> = {
    'selection-disconnect': { path: 'packages/connectors/src/connection-services.ts', before: '...(publicationStore ? { contextPublications: publicationStore } : {}),', after: '' },
    'bot-filter': { path: 'packages/connectors/src/durable-ingress.ts', before: '!known.has(item.messageId)', after: "item.author.kind !== 'bot'" },
    'source-predicate-ignore': { path: 'packages/connectors/src/publication-store.ts', before: "json_extract(original.operation_json,'$.reference.source.nativeSessionId')=?", after: '? IS NOT NULL', extra: ["json_extract(source.value,'$.source.nativeSessionId') IS NOT ?", '? IS NULL'] },
    'relay-ignore': { path: 'packages/connectors/src/publication-store.ts', before: "json_extract(original.operation_json,'$.payload.relay') IS NULL", after: '1=1' },
    'source-observation-ignore': { path: 'packages/connectors/src/durable-ingress.ts', before: "handle?.kind === 'provider' && !session?.nativeSourceObservation", after: "handle?.kind === 'provider'" },
    'observation-disconnect': { path: 'packages/connectors/src/durable-ingress.ts', before: "catch { contextObservation = 'known-publications-unavailable' }", after: 'catch {}' },
  }
  const variant = mutant ? variants[mutant] : undefined
  if (mutant && !variant) throw Error('Unknown quote selection mutant')
  let loaded = original
  if (variant?.path === path) {
    for (const [before, after] of [[variant.before, variant.after], ...(variant.extra ? [variant.extra] : [])]) {
      if (loaded.split(before!).length !== 2) throw Error('Exact quote selection mutation must load once')
      loaded = loaded.replace(before!, after!)
    }
  }
  if (process.env.QUOTE_SELECTION_LOADED && (/^packages\/(core|connectors)\/src\//u.test(path) || path === 'packages/connectors/src/connection-services.ts')) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.QUOTE_SELECTION_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(variant?.path === path ? { mutation: mutant } : {}) }) + '\n')
  }
  if (loaded !== original) return loaded
} }], test: { ...native.test, include: ['packages/connectors/test/channel-quote-selection.test.ts', 'packages/connectors/test/publication-context.test.ts', 'packages/connectors/test/discord-channel.test.ts'], testNamePattern: /quote selection/u, testTimeout: 30000 } })
