import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const mutation = process.env.AGENT_LEARNING_MUTANT
const variants = {
  'proposer-authority': ['apps/host/src/agent-learning-owner.ts', 'context.caller?.agentSessionId !== operation.proposer.agentSessionId', 'false'],
  'confirmation-binding': ['apps/host/src/agent-learning-owner.ts', 'await this.options.confirmation(input.confirmationId, binding)', 'void 0'],
  'target-binding': ['apps/host/src/agent-learning-owner.ts', 'workspacePath: target.workspacePath', 'workspacePath: value.extraction.input.workspacePath'],
  'unknown-replay': ['apps/host/src/agent-learning-owner.ts', 'if (launch.dispatched && !explicit) return', 'if (false) return'],
  'ipc-trust': ['apps/desktop/src/main/agent-learning-ipc.ts', "assertSenderTrusted(senderTrust('agentLearning:call', event.sender, options.contents))", 'void 0'],
  'ipc-frame': ['apps/desktop/src/main/agent-learning-ipc.ts', 'if (senderFrame !== options.mainFrame())', 'if (false)'],
  'review-target': ['apps/desktop/src/renderer/src/components/SessionLearningSurface.tsx', 'target: selectedTarget, executorId', 'target: targets[0]!.target, executorId']
} as const
if (mutation && !Object.hasOwn(variants, mutation)) throw new Error('Unknown learning mutation')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  resolve: { alias: [{ find: /^react(?=\/|$)/u, replacement: resolve(root, 'apps/desktop/node_modules/react') },
    { find: /^react-dom(?=\/|$)/u, replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }] },
  plugins: [{ name: 'original-learning-source', enforce: 'pre',
  resolveId(source) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const entry = core.exports['./' + source.slice('@agentmux/core/'.length)]?.import
      if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    }
  },
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/core)\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    const selected = mutation ? variants[mutation as keyof typeof variants] : null
    let served = original
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw new Error('Mutation must identify one original owning expression')
      served = original.replace(selected[1], selected[2])
    }
    if (process.env.AGENT_LEARNING_TRACE) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = JSON.stringify({ path, originalSHA: hash(original), servedSHA: hash(served), ...(served !== original ? { mutation } : {}) }) + '\n'
      return { code: "import { appendFileSync as __learningLoad } from 'node:fs'; __learningLoad(" + JSON.stringify(process.env.AGENT_LEARNING_TRACE) + ',' + JSON.stringify(row) + ');\n' + served, map: null }
    }
    return served !== original ? { code: served, map: null } : undefined
  }
}], test: { include: ['apps/host/test/agent-learning*.test.ts', 'apps/host/test/agent-learning*.test.tsx', 'packages/core/test/agent-platform-task.test.ts', 'packages/core/test/agent-learning-codec.test.ts',
  'apps/desktop/test/session-takeover.test.tsx'], environment: 'node', fileParallelism: false,
  passWithNoTests: false, testTimeout: 30_000, hookTimeout: 15_000 } })
