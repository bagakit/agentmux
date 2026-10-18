import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

export default defineConfig({ ...native, plugins: [...native.plugins!, { name: 'original-ingress-context-loaded-mutants', enforce: 'pre', transform(original, id) {
  const path = relative(native.root!, id.split('?')[0]!), mutant = process.env.CHANNEL_CONTEXT_MUTANT
  const nativeGuard = "if (receipt.status !== 'admitted' || admission?.transport !== 'native' || !admission.acknowledged ||\n        admission.native.outcome !== 'admitted' || admission.native.plan.threadId !== recipient.source.nativeSessionId ||\n        quote.coverage !== 'complete' || quote.gaps.length || quote.range.throughMessageId !== record.externalMessageId) return false"
  const variants: Record<string, { path: string; changes: [string, string][] }> = {
    'position-disconnect': { path: 'packages/connectors/src/ingress-context.ts', changes: [["if (receipt.status !== 'admitted' ||", "if (true || receipt.status !== 'admitted' ||"]] },
    'position-ignore': { path: 'packages/connectors/src/ingress-context.ts', changes: [['if (position) return', 'if (false && position) return']] },
    'terminal-promote': { path: 'packages/connectors/src/ingress-context.ts', changes: [["if (receipt.status === 'terminal-confirmed' || receipt.status === 'not-applied')", "if (receipt.status === 'not-applied')"], [nativeGuard, "if (receipt.status !== 'admitted' && receipt.status !== 'terminal-confirmed') return false"]] },
    'partial-promote': { path: 'packages/connectors/src/ingress-context.ts', changes: [["quote.coverage !== 'complete' || quote.gaps.length ||", 'false ||']] },
    'unknown-promote': { path: 'packages/connectors/src/ingress-context.ts', changes: [[nativeGuard, "if ((receipt.status !== 'admitted' && receipt.status !== 'unknown') || quote.coverage !== 'complete' || quote.gaps.length) return false"]] },
    'quote-disconnect': { path: 'packages/connectors/src/durable-ingress.ts', changes: [['...(ref.channelQuote ? { channelQuote: ref.channelQuote } : {}), recipient:', 'recipient:']] },
    'history-forward-disconnect': { path: 'packages/connectors/src/connection-host.ts', changes: [['...(ingress.readHistory ? { readHistory:', '...(false && ingress.readHistory ? { readHistory:']] },
    'lazy-native-disconnect': { path: 'packages/connectors/src/platform-adapters.ts', changes: [['readHistory: async (...input) => (await feishu()).readHistory(...input)', 'readHistory: undefined']] }
  }
  let code = original
  const selected = mutant ? variants[mutant] : undefined
  if (mutant && !selected) throw Error('Unknown context mutation')
  if (selected?.path === path) for (const [before, after] of selected.changes) {
    if (code.split(before).length !== 2) throw Error('Exact context mutant must load once: ' + mutant)
    code = code.replace(before, after)
  }
  if (process.env.CHANNEL_CONTEXT_LOADED && (/^packages\/(core|connectors)\/src\//u.test(path) || ['apps/desktop/src/main/connector-host.ts', 'apps/host/src/external-input-authority.ts'].includes(path))) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.CHANNEL_CONTEXT_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(selected?.path === path ? { mutation: mutant } : {}) }) + '\n')
  }
  if (code !== original) return code
} }], test: { ...native.test, include: ['packages/connectors/test/channel-context-consumer.test.ts'], testTimeout: 30000 } })
