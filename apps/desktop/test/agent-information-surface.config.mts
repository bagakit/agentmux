import { defineConfig } from 'vitest/config'
import base from './vitest.ui-controls-owning.config.mts'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations = [
  ['apps/desktop/src/renderer/src/lib/use-agent-native-information.ts', 'at - previous.at >= SAMPLE_INTERVAL', 'at - previous.at >= SAMPLE_INTERVAL * 2'],
  ['apps/desktop/src/renderer/src/components/AgentAvatar.tsx', 'near.bottom - near.top >= naturalHeight || ', ''],
  ['packages/client-ui/src/components/AgentComposer.tsx',
    `            {configurationTool || contextUsage ? <div className="composer-session-controls__settings">{configurationTool}{contextUsage}</div> : null}
            {mailbox || identity ? <div className="composer-session-controls__activity">{mailbox}{identity}</div> : null}`,
    `            {mailbox || identity ? <div className="composer-session-controls__activity">{mailbox}{identity}</div> : null}
            {configurationTool || contextUsage ? <div className="composer-session-controls__settings">{configurationTool}{contextUsage}</div> : null}`],
] as const
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), ...(process.env.AMX_MUTATE_COMPOSER_INFORMATION === '1' ? [{
  name: 'mutate-composer-information', enforce: 'pre' as const,
  transform(code: string, id: string) {
    const mutation = mutations.find(([path]) => id === resolve(root, path))
    if (!mutation) return
    const [, before, after] = mutation
    if (code.split(before).length !== 2) throw new Error(`Expected one mutation anchor in ${mutation[0]}`)
    return { code: code.replace(before, after), map: null }
  }
}] : [])], resolve: { ...base.resolve, alias: [
  { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(realpathSync(resolve(root, 'packages/core/node_modules/@agentmux/identity')), 'dist/runtime-source.js') },
  ...base.resolve!.alias as []
] }, test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/agent-information-surface.test.tsx',
  'apps/desktop/test/agent-status-prompt-actions.test.tsx', 'apps/desktop/test/composer-session-controls.test.tsx', 'apps/desktop/test/composer-identity.test.tsx'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15000 } })
