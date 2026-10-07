import { defineConfig } from 'vitest/config'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(pkg.exports).flatMap(([name, value]) => {
  const source = resolve(root, 'packages/core/src/' + (value as { import: string }).import.replace('./dist/', '').replace(/\.js$/u, '.ts'))
  const spec = name === '.' ? '@agentmux/core' : '@agentmux/core' + name.slice(1)
  return existsSync(source) ? [{ find: new RegExp('^' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: source }] : []
})
const mutation = process.env.AGENTMUX_TURN_SUMMARY_MUTATION
const mutations: Record<string, [string, string, string]> = {
  'drop-metrics': ['packages/client-ui/src/lib/conversation-metrics.ts', 'const metrics = item.metrics', 'const metrics = undefined'],
  'sum-cumulative': ['packages/client-ui/src/lib/conversation-metrics.ts', 'metrics: { ...previous?.observation.metrics, ...metrics },',
    'metrics: { ...previous?.observation.metrics, ...metrics, ...(metrics.usage ? { usage: { ...metrics.usage, outputTokens: (previous?.observation.metrics.usage?.outputTokens ?? 0) + (metrics.usage.outputTokens ?? 0) } } : {}) },'],
  'forget-read-body': ['packages/client-ui/src/components/WorkflowObservation.tsx', 'expanded || readOnce ? children : null', 'expanded ? children : null'],
  'unstable-record-wrapper': ['packages/client-ui/src/components/ConversationRecordSequence.tsx', 'renderRecord: (item, wrapBody) => renderOne(item, wrapBody, false, !summary)', 'renderRecord: summary ? renderRecord : (item, wrapBody) => renderOne(item, wrapBody, false)'],
  'hide-recorded-failure': ['packages/client-ui/src/components/NativeProcessObservation.tsx', "const status = recordedStepStatus ?? (metrics?.metrics.status === 'completed' ? 'complete' : metrics?.metrics.status)", "const status = metrics?.metrics.status === 'completed' ? 'complete' : metrics?.metrics.status ?? recordedStepStatus"],
  'guess-legacy-turn': ['apps/desktop/src/renderer/src/lib/agent-usage.ts', "'Latest report · scope unrecorded'", "'Last turn'"]
}

export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: { conditions: ['browser', 'import', 'default'], alias: [...aliases,
    { find: /^react$/, replacement: resolve(root, 'apps/desktop/node_modules/react') },
    { find: /^react-dom$/, replacement: resolve(root, 'apps/desktop/node_modules/react-dom') },
    { find: /^react\/(.*)$/, replacement: resolve(root, 'apps/desktop/node_modules/react/$1') },
    { find: /^react-dom\/(.*)$/, replacement: resolve(root, 'apps/desktop/node_modules/react-dom/$1') }
  ] },
  cacheDir: resolve(root, '.cache/turn-summary-' + (mutation ?? 'base')),
  plugins: [{ name: 'turn-summary-source-proof', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/packages/client-ui/src/') && !file.startsWith(root + '/apps/desktop/src/')) return
    const original = code, chosen = mutation ? mutations[mutation] : undefined
    if (process.env.AGENTMUX_TURN_SUMMARY_BASELINE && ['NativeProcessObservation.tsx', 'ConversationRecordSequence.tsx', 'WorkflowObservation.tsx'].some(name => file === resolve(root, 'packages/client-ui/src/components', name))) {
      code = execFileSync('git', ['show', 'HEAD:' + relative(root, file)], { cwd: root, encoding: 'utf8' })
    }
    if (chosen && file === resolve(root, chosen[0])) {
      if (code.split(chosen[1]).length !== 2) throw new Error('Missing unique actual mutation anchor: ' + mutation)
      code = code.replace(chosen[1], chosen[2])
    }
    if (process.env.AGENTMUX_TURN_SUMMARY_LOADED) appendFileSync(process.env.AGENTMUX_TURN_SUMMARY_LOADED, JSON.stringify({
      file: relative(root, file), sha256: createHash('sha256').update(original).digest('hex'), ...(code !== original ? { mutation } : {})
    }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { environment: 'happy-dom', server: { deps: { inline: ['@agentmux/client-ui'] } },
    include: ['packages/client-ui/test/conversation-metrics.test.tsx', 'apps/desktop/test/agent-usage-display.test.ts',
      'apps/desktop/test/native-process-reading.test.tsx', 'apps/desktop/test/native-empty-reasoning-reading.test.tsx'],
    passWithNoTests: false, fileParallelism: false }
})
