import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import original, { executionUiAliases } from './vitest.tool-execution-ui.config.mts'
const repository = resolve(import.meta.dirname, '../../..')
const client = resolve(repository, 'packages/client-ui')
const clientExports = JSON.parse(readFileSync(resolve(client, 'package.json'), 'utf8')).exports
const clientAliases = Object.entries(clientExports).sort(([left], [right]) => right.length - left.length).flatMap(([key, spec]) => {
  const target = typeof spec === 'string' ? spec : (spec as { browser?: string }).browser
  if (!target?.startsWith('./src/')) return []
  const name = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)')
  return [{ find: new RegExp(`^${pattern}$`), replacement: resolve(client, target).replace('*', '$1') }]
})
const mutant = process.env.SESSION_RESOURCE_MUTANT
const mutations: Record<string, [string, string, string]> = {
  'binding-address': ['lib/session-resource-context.ts', 'const binding = session.kind === \'agent\' ? session.toolExecution : undefined', 'const binding = undefined'],
  'composer-files': ['components/AgentSessionComposer.tsx', 'const workspace = resource.workspace', 'const workspace = runtimeWorkspace'],
  'launcher-skills': ['lib/use-composer-candidates.tsx', 'api.ui.listWorkspaceSkills(runtimeWorkspace.id, providerId)', 'api.ui.listWorkspaceSkills(workspace!.id, providerId)'],
  'attachment-files': ['lib/use-composer-attachments.ts', "const files = fileResource === undefined ? { hostId, workspacePath } : fileResource", "const files = { hostId, workspacePath }"],
  'body-workspace': ['lib/session-link-opening.ts', 'const workspaceId = context.workspaceId ?? context.project?.workspaceId', 'const workspaceId = origin.workspaceId'],
}
if (mutant && !mutations[mutant]) throw new Error('Unknown Session resource mutation: ' + mutant)
export default defineConfig({ ...original, resolve: { alias: [...clientAliases, ...executionUiAliases] },
  plugins: [{ name: 'session-resource-counterexample', enforce: 'pre', transform(source, id) {
    if (!mutant) return
    const [file, before, after] = mutations[mutant]!
    if (!id.endsWith('/' + file)) return
    const occurrences = source.split(before).length - 1
    if (occurrences !== (mutant === 'body-workspace' ? 2 : 1)) throw new Error('Mutation must hit actual source: ' + mutant + ' / ' + occurrences)
    process.stderr.write('SESSION_RESOURCE_MUTANT_HIT ' + mutant + '\n')
    return { code: source.replaceAll(before, after), map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/session-resource-context.test.tsx', 'apps/desktop/test/session-pane-project-file-links.test.tsx', 'apps/desktop/test/agent-session-composer-reference-open.test.tsx', 'apps/desktop/test/composer-completion-consumers.test.tsx'], passWithNoTests: false },
  cacheDir: resolve(repository, '.tmp/session-resource-context/cache') })
