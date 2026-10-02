import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

// Candidate must be installed at this exact tracked fixture path. Keep the
// repository's ordinary Core/Demand freshness globalSetup and real resolution.
const root = resolve(import.meta.dirname, '../../../../..')
const publicTimeline = realpathSync(fileURLToPath(import.meta.resolve('@agentmux/core/timeline')))
if (publicTimeline !== realpathSync(resolve(root, 'packages/core/dist/session-timeline.js'))) {
  throw new Error('Working history must consume this proof tree public Core dist.')
}
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
const mutation = process.env.AGENTMUX_FOCUS_WORK_MUTATION
const mapPath = process.env.AGENTMUX_FOCUS_WORK_MUTATION_MAP
// Exact match strings/SHA come from the Root-owned qualified UI expression;
// this preparation does not invent future Core DTOs or product expressions.
type Change = { path: string; sourceSHA256: string; from: string; to: string }
const knownMutations = ['drop-closed-working', 'current-state-only']
let change: Change | undefined
if (mutation) {
  if (!knownMutations.includes(mutation) || !mapPath) throw new Error('Exact reviewed semantic mutation map required.')
  change = (JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, Change>)[mutation]
  if (!change?.path || !change.from || !change.to || !/^[a-f0-9]{64}$/u.test(change.sourceSHA256)) {
    throw new Error('Semantic mutation cannot run with a missing or guessed Source binding.')
  }
  if (!change.path.startsWith('apps/desktop/src/renderer/src/')) throw new Error('Only the owning UI Source may be mutated.')
}
export default defineConfig({
  ...original,
  root,
  define: { ...original.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  cacheDir: resolve(root, '.tmp/focus-work-history-vitest-cache'),
  plugins: [...(original.plugins ?? []), {
    name: 'focus-working-history-loaded-source', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!, path = relative(root, file)
      if (!path.startsWith('apps/desktop/src/renderer/src/') || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const before = code
      if (change && path === change.path) {
        if (hash(code) !== change.sourceSHA256 || code.split(change.from).length !== 2) {
          throw new Error('Mutation must bind one actual loaded owning expression at the reviewed Source SHA.')
        }
        code = code.replace(change.from, change.to)
      }
      const receipt = process.env.AGENTMUX_FOCUS_WORK_LOADED_SOURCE
      if (!receipt) throw new Error('Owning execution requires a loaded Source receipt path.')
      appendFileSync(receipt, JSON.stringify({ path, originalSHA256: hash(before), sha256: hash(code), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n')
      return before === code ? undefined : { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/focus-work-history.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000 }
})
