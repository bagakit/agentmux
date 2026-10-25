import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_REMOTE_SETTINGS_EVIDENCE
assert(evidence, 'An explicit evidence directory is required')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_REMOTE_SETTINGS_MUTANT
const edits: Record<string, [string, string, string][]> = {
  navigation: [['components/settings/modules/remote-execution.tsx', "group: 'remote'", "group: 'agents'"]],
  'wrong-project': [['components/settings/RemoteExecutionSettingsPane.tsx', 'state.openLauncher({ workspaceId: project.id, reveal: true })', 'state.openLauncher({ workspaceId: state.config!.workspaces[0]!.id, reveal: true })']],
  'hidden-reader': [
    ['components/settings/RemoteExecutionSettingsPane.tsx', 'active ? state.sessions : NO_SESSIONS', 'state.sessions'],
    ['components/settings/RemoteExecutionSettingsPane.tsx', 'visible={active} presentation="inline"', 'visible={true} presentation="inline"']
  ],
  'foreign-binding': [['components/AgentToolExecutionNotice.tsx', 'value.bindingId !== binding?.bindingId', 'false']],
  'late-refresh': [['components/AgentToolExecutionNotice.tsx', 'latest.current === original && original.revision === revision', 'true']],
  'null-erase': [['components/AgentToolExecutionNotice.tsx', 'if (value === null) {', 'if (false) {']]
}
assert(!mutant || edits[mutant], 'Only a declared real-source mutant is supported')
const sha = (input: string) => createHash('sha256').update(input).digest('hex')
const hostExports = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports
const hostAliases = Object.entries(hostExports).map(([key, value]) => ({
  find: new RegExp('^@agentmux/host' + (key === '.' ? '' : key.slice(1)) + '$'),
  replacement: resolve(root, 'apps/host', (typeof value === 'string' ? value : (value as { import: string }).import)
    .replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
}))
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: [...hostAliases, ...aliases] },
  plugins: [{ name: 'remote-settings-source-consumer', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(id)) return
      if (input !== readFileSync(id, 'utf8')) return
      appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path: relative(root, id), sha256: sha(input) }) + '\n')
      const mutations = mutant ? edits[mutant]!.filter(([suffix]) => id.endsWith('/' + suffix)) : []
      if (!mutations.length) return
      let output = input
      for (const [, before, after] of mutations) {
        // The late-refresh guard occurs on success and failure; both must retain the same fence.
        const count = mutant === 'late-refresh' ? 2 : 1
        assert.equal(output.split(before).length - 1, count, 'Mutation must match its precise original source anchor')
        output = output.replaceAll(before, after)
      }
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path: relative(root, id), original: sha(input), consumed: sha(output) }) + '\n')
      return { code: output, map: null }
    } }],
  test: { include: ['apps/desktop/test/remote-execution-settings.test.tsx', 'apps/desktop/test/settings-connections.test.tsx',
    'apps/desktop/test/tool-execution-notice.test.tsx', 'apps/desktop/test/launcher-tool-execution.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 20000 }
})
