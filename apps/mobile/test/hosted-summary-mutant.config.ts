import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { hostedSummaryMutations, hostedSummaryTests } from '../../../packages/core/test/hosted-summary-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.HOSTED_SUMMARY_MUTATION
if (mutation && !Object.hasOwn(hostedSummaryMutations, mutation)) throw Error('Unknown Hosted summary mutation')
const variant = mutation ? hostedSummaryMutations[mutation as keyof typeof hostedSummaryMutations] : undefined
const kind = variant?.kind ?? process.env.HOSTED_SUMMARY_TEST_KIND
if (!kind || !Object.hasOwn(hostedSummaryTests, kind)) throw Error('Choose a Hosted summary bearing suite')
const testKind = kind as keyof typeof hostedSummaryTests
const files = new Set(['packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-session-summary.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/agent-prompt-condition.ts', 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', ...Object.values(hostedSummaryTests)])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/hosted-summary', mutation ?? kind),
  resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] }, plugins: [react(), {
    name: 'loaded-hosted-summary-source', enforce: 'pre', transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!files.has(path)) return
      let code = original
      if (variant?.file === path) {
        if (code.split(variant.before).length !== 2) throw Error('The Hosted summary mutation must match exactly once: ' + mutation)
        code = code.replace(variant.before, variant.after)
      }
      if (process.env.HOSTED_SUMMARY_LOADED) {
        const record = { path, originalSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), loadedSHA256: sha(code), mutation: variant?.file === path ? mutation : null }
        appendFileSync(process.env.HOSTED_SUMMARY_LOADED, JSON.stringify({ ...record, phase: 'loaded' }) + '\n')
        code += '\n;import { appendFileSync as __hostedSummaryEvaluated } from "node:fs";__hostedSummaryEvaluated(' +
          JSON.stringify(process.env.HOSTED_SUMMARY_LOADED) + ', ' + JSON.stringify(JSON.stringify({ ...record, phase: 'evaluated' }) + '\n') + ');\n'
      }
      return { code, map: null }
    }
  }], test: { environment: kind === 'mobile' ? 'happy-dom' : 'node', setupFiles: kind === 'mobile' ? ['test/device-locks.ts'] : [],
    include: [resolve(root, hostedSummaryTests[testKind])], ...(variant ? { testNamePattern: variant.target } : {}),
    restoreMocks: true, passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30_000 }
})
