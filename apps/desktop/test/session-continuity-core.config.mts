import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig, defaultExclude } from 'vitest/config'
import owning from '../../../vitest.config'
import source from '../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'working-gate': { file: 'packages/core/src/agent-session-recovery/continuity-policy.ts', before: "status.state === 'working'", after: "status.state === 'done'" },
  'unknown-missing': { file: "packages/core/src/agent-session-recovery/continuity-attempt.ts", before: "if (!(error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found')) {", after: "if (false) {" },
  'expected-run': { file: "packages/core/src/agent-session-recovery/continuity-attempt.ts", before: "if (current && !sameRun(current.run, input.expectedRun)) {", after: "if (false) {" },
  'healthy-resume': { file: 'packages/core/src/agent-session-recovery/continuity-policy.ts', before: "if (facts.run?.state === 'running') {", after: 'if (false) {' },
  'atomic-receipt': { file: "packages/core/src/agent-session-recovery/lifecycle.ts", before: "if (continuity?.operationId === input.operationId && continuity.kind === 'starting') {", after: "if (false) {" },
  'committed-health': { file: "packages/core/src/agent-session-recovery/lifecycle.ts", before: "if (reservation.kind === 'resume' && continuity?.operationId === input.operationId) {", after: 'if (false) {' },
  'parked-rejoin': { file: "packages/core/src/agent-session-recovery/continuity-attempt.ts", before: "['active-delay', 'operation-unconfirmed'].includes(current.continuity.reason)", after: "true" },
  'ended-fresh-input': { file: 'apps/desktop/src/renderer/src/store.ts', before: "entry.promptCondition === null && session.processState === 'running' && !session.pendingInteraction)", after: 'entry.promptCondition === null && !session.pendingInteraction)' },
  'startup-trigger': { file: 'apps/desktop/src/renderer/src/store.ts', before: "{ stillCurrent: current, trigger: 'startup' }", after: "{ stillCurrent: current, trigger: 'manual' }" }
}
const mutation = process.env.AGENTMUX_CONTINUITY_MUTATION ? mutations[process.env.AGENTMUX_CONTINUITY_MUTATION] : undefined
const loaded = process.env.AGENTMUX_CONTINUITY_LOADED
if (process.env.AGENTMUX_CONTINUITY_MUTATION && !mutation) throw new Error('Unknown continuity mutation')
export default defineConfig({ ...owning, root,
  esbuild: source.esbuild,
  resolve: { alias: [
    { find: '@agentmux/identity/runtime-source', replacement: resolve(root, 'packages/identity/dist/runtime-source.js') },
    { find: /^@agentmux\/client-ui\/components\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1') },
    { find: /^@agentmux\/client-ui\/terminal\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/terminal/$1') },
    { find: /^@agentmux\/client-ui\/note\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/note/$1') },
    { find: '@agentmux/client-ui/input/styles.css', replacement: resolve(root, 'packages/client-ui/src/input/input.css') },
    { find: '@agentmux/client-ui/styles.css', replacement: resolve(root, 'packages/client-ui/src/styles/index.css') },
    { find: /^@agentmux\/client-ui\/styles\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/styles/$1') },
    { find: '@agentmux/client-ui/input', replacement: resolve(root, 'packages/client-ui/src/input/index.ts') },
    { find: '@agentmux/client-ui/platform', replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
    { find: '@agentmux/client-ui/theme', replacement: resolve(root, 'packages/client-ui/src/theme/index.ts') },
    { find: '@agentmux/client-ui/icons', replacement: resolve(root, 'packages/client-ui/src/theme/icons.tsx') },
    { find: /^@agentmux\/client-ui\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1') },
    ...source.resolve.alias
  ] },
  plugins: mutation ? [{ name: 'loaded-continuity-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== resolve(root, mutation.file)) return
    if (code.split(mutation.before).length !== 2) throw new Error('Mutation target must match the actual owner exactly once')
    const changed = code.replace(mutation.before, mutation.after)
    if (loaded) appendFileSync(loaded, JSON.stringify({ file: mutation.file,
      originalSHA256: createHash('sha256').update(code).digest('hex'),
      loadedSHA256: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return { code: changed, map: null }
  } }] : [],
  // This gate consumes workspace source; compiled CLI proof keeps its own freshness guard.
  test: { ...owning.test, globalSetup: [], exclude: defaultExclude,
    include: ['packages/core/test/agent-session-continuity.test.ts', 'apps/desktop/test/session-continuity-consumers.test.ts'],
    passWithNoTests: false, maxWorkers: 1 }
})
