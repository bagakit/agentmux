import { defineConfig } from 'vitest/config'
import base from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export default defineConfig({ ...base, cacheDir: '.cache/ingress-context-recovery', plugins: [...base.plugins!, {
  name: 'ingress-original-context-loaded-mutants', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    const variants: Record<string, { path: string; before: string; after: string }> = {
      'local-result-awaits-body': { path: 'packages/connectors/src/durable-ingress.ts', before: 'void this.dispatchOriginal(input.ingressId, undefined, true).catch', after: 'await this.dispatchOriginal(input.ingressId, undefined, true).catch' },
      'local-result-reads-core': { path: 'packages/connectors/src/durable-ingress.ts', before: "input.source.kind === 'context-observation' ? this.inspectLocal(input.ingressId)", after: "input.source.kind === 'context-observation' ? await this.inspect({ ingressId: input.ingressId })" },
      'weak-observation-release': { path: 'packages/connectors/src/durable-ingress.ts', before: 'await observeRead(call(accurate), accurate)', after: 'await call(accurate)' },
      'core-inspect-signal': { path: 'packages/connectors/src/core-ingress-port.ts', before: "invoke('inspectAgentInput', [input], fence, signal)", after: "invoke('inspectAgentInput', [input], fence)" },
      'public-context-dispatch': { path: 'packages/connectors/src/durable-ingress.ts', before: 'action = this.endContextObservation(input, selected.record)', after: "action = { ...selected.action, outcome: 'stale' }" },
      'original-source-consumption': { path: 'packages/connectors/src/durable-ingress.ts', before: 'current.observationId === observationId && current.target.source', after: 'current.target.source' },
      'durable-gap-freeze': { path: 'packages/connectors/src/durable-ingress.ts', before: "this.writePreparation(input.ingressId, { ...current, phase: 'ended', quote, gaps: quote.gaps })", after: "this.writePreparation(input.ingressId, { ...current, phase: 'ended', gaps: quote.gaps })" },
      'original-generation-claim': { path: 'packages/connectors/src/durable-ingress.ts', before: 'if (work?.observer && this.readPreparation(ingressId)?.observationId !== work.observer.observationId)', after: 'if (false)' },
      'frozen-quote-consumer': { path: 'packages/connectors/src/durable-ingress.ts', before: '...(ref.channelQuote ? { channelQuote: ref.channelQuote } : {}), recipient:', after: 'recipient:' },
      'accepted-position-guard': { path: 'packages/connectors/src/ingress-context.ts', before: "quote.coverage !== 'complete' || quote.gaps.length ||", after: 'false ||' }
    }
    const mutation = process.env.INGRESS_CONTEXT_MUTANT, selected = mutation ? variants[mutation] : undefined
    if (mutation && !selected) throw Error('Unknown original-context mutation: ' + mutation)
    let loaded = original
    if (selected?.path === path) {
      if (original.split(selected.before).length !== 2) throw Error('Exact original-context mutation must load once: ' + mutation)
      loaded = original.replace(selected.before, selected.after)
    }
    if (process.env.INGRESS_CONTEXT_LOADED && /^packages\/(core|connectors)\/src\//u.test(path)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.INGRESS_CONTEXT_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(selected?.path === path ? { mutation } : {}) }) + '\n')
    }
    if (loaded !== original) return loaded
  }
}], test: { ...base.test,
  include: ['packages/connectors/test/ingress-context-recovery.test.ts', 'packages/connectors/test/ingress-context-crash.test.ts', 'packages/connectors/test/channel-context-consumer.test.ts'], maxWorkers: 1, testTimeout: 30000 } })
