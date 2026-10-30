import { defineConfig } from 'vitest/config'
import base from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

export default defineConfig({ ...base, cacheDir: '.cache/context-read-policy', plugins: [...base.plugins!, {
  name: 'accurate-read-policy-loaded-mutants', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    const variants: Record<string, { path: string; before: string; after: string }> = {
      'request-signal-disconnect': { path: 'packages/connectors/src/adapters/feishu/index.ts', before: '[receiverSignal, scope?.signal, input.signal]', after: '[receiverSignal, scope?.signal]' },
      'request-window-disconnect': { path: 'packages/connectors/src/adapters/feishu/index.ts', before: ')), READ_OBSERVATION_MS)', after: ')), READ_OBSERVATION_MS * 100)' },
      'business-window': { path: 'packages/connectors/src/adapters/feishu/index.ts', before: 'return await this.requests.run(signal ? { signal } : {}, () => call(this.client(config, credential)))', after: 'return await this.withReadClient(config, credential, call, signal)' },
      'whole-quote-window': { path: 'packages/connectors/src/adapters/feishu/index.ts', before: 'signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal', after: 'signal = AbortSignal.any([...(outerSignal ? [outerSignal] : []), controller.signal, AbortSignal.timeout(15_000)])' },
      'discord-uncooperative': { path: 'packages/connectors/src/adapters/discord/history.ts', before: 'await observeRead(rest.get(path, { ...options, signal: current }), current)', after: 'await rest.get(path, { ...options, signal: current })' }
    }
    const mutation = process.env.CONTEXT_READ_MUTANT, selected = mutation ? variants[mutation] : undefined
    if (mutation && !selected) throw Error('Unknown accurate-read mutation: ' + mutation)
    let loaded = original
    if (selected?.path === path) {
      if (original.split(selected.before).length !== 2) throw Error('Exact accurate-read mutation must load once: ' + mutation)
      loaded = original.replace(selected.before, selected.after)
    }
    if (process.env.CONTEXT_READ_LOADED && /^packages\/(core|connectors)\/src\//u.test(path)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.CONTEXT_READ_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(selected?.path === path ? { mutation } : {}) }) + '\n')
    }
    if (loaded !== original) return loaded
  }
}], test: { ...base.test,
  include: ['packages/connectors/test/context-read-policy.test.ts', 'packages/connectors/test/channel-history-native.test.ts'],
  maxWorkers: 1, testTimeout: 20000, hookTimeout: 20000 } })
