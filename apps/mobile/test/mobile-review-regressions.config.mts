import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import base from '../vitest.config'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

// From the repository root:
// node node_modules/vitest/vitest.mjs run --config apps/mobile/test/mobile-review-regressions.config.mts
// Prefix MOBILE_REVIEW_MUTATION=<name> to run one bounded counterfactual; it must fail its owning assertion.
// Optional MOBILE_REVIEW_LOADED=<jsonl path> records executed source hashes, including normal runs.
const root = resolve(import.meta.dirname, '../../..')
const mobileRequire = createRequire(resolve(root, 'apps/mobile/package.json'))
const mutation = process.env.MOBILE_REVIEW_MUTATION, report = process.env.MOBILE_REVIEW_LOADED
const changes: Record<string, { file: string; before: string; after: string; suite: string; target: string }> = {
  'raw-recovery-result': {
    file: 'apps/mobile/src/conversation/mobile-agent-recovery.ts',
    before: "notice('恢复还没完成，可以核对结果或继续这次恢复。', `${operation.kind}\\n${operation.error ?? operation.reason}`)",
    after: 'notice(`恢复没有完成：${operation.kind}。${operation.error ?? operation.reason}`)',
    suite: 'mobile-agent-actions.test.tsx', target: 'keeps a recovery failure readable'
  },
  'terminal-owner-wording': {
    file: 'apps/mobile/src/terminal/control.ts', before: 'owner?.hostId !== facts.identity.hostId', after: 'true',
    suite: 'terminal-control.test.ts', target: 'rebinds without forwarding retained input'
  },
  'copy-jsx-blind': {
    file: 'apps/mobile/test/mobile-copy-quiet.test.ts', before: 'ts.isJsxText(node) || ts.isStringLiteral(node)', after: 'ts.isStringLiteral(node)',
    suite: 'mobile-copy-quiet.test.ts', target: 'scans real production files'
  }
}
if (mutation && !Object.hasOwn(changes, mutation)) throw Error('Unknown mobile review mutation: ' + mutation)
const variant = mutation ? changes[mutation] : undefined
const suites = [
  'mobile-copy-quiet.test.ts', 'mobile-agent-actions.test.tsx', 'mobile-agent-recovery.test.tsx', 'terminal-control.test.ts',
  'goal-draft-record.test.ts', 'mobile-survey-owner.test.tsx', 'mobile-goal-recovery-race.test.tsx'
]
const owners = new Set([
  'apps/mobile/src/conversation/MobileAgentActions.tsx',
  'apps/mobile/src/conversation/mobile-agent-recovery.ts', 'apps/mobile/src/terminal/control.ts',
  ...suites.map(file => 'apps/mobile/test/' + file)
])
const runtime = `export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
export default defineConfig({ ...base,
  root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/mobile-review-regressions', mutation ?? 'normal'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { ...base.resolve, alias: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-dom/test-utils'].map(name => ({ find: new RegExp('^' + name + '$'), replacement: mobileRequire.resolve(name) })) },
  plugins: [{ name: 'actual-mobile-review-owners', enforce: 'pre',
    resolveId(id) { if (id === '@agentmux/identity/runtime-source') return '\0mobile-review-identity'; return workspaceSourceExport(root, id) },
    load(id) { if (id === '\0mobile-review-identity') return runtime },
    transform(original, id) {
      const file = relative(root, id.split('?')[0]!)
      if (!owners.has(file)) return
      let code = original
      if (variant?.file === file) {
        if (code.split(variant.before).length !== 2) throw Error('Expected one loaded-source mutation anchor: ' + mutation)
        code = code.replace(variant.before, variant.after)
      }
      if (report) {
        const row = { file, originalSHA256: sha(readFileSync(resolve(root, file), 'utf8')), loadedSHA256: sha(code), mutation: variant?.file === file ? mutation : null }
        code = `import { appendFileSync as __reviewLoaded } from 'node:fs'; __reviewLoaded(${JSON.stringify(resolve(root, report))},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + code
      }
      return code === original ? undefined : { code, map: null }
    }
  }, ...(base.plugins ?? [])],
  test: { ...base.test, env: { MOBILE_TEST_BUILD_ID: 'reviewed-page-build' },
    setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts'), resolve(root, 'apps/mobile/test/mobile-build-identity-setup.ts')],
    include: (variant ? [variant.suite] : suites).map(file => 'test/' + file),
    testNamePattern: variant?.target, passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
