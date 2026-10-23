import { defineConfig } from 'vitest/config'
import original from './agent-learning.config.mts'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

// Native Files prerequisite on the supported Darwin host:
//   node apps/desktop/scripts/build-workspace-move-helper.mjs
//   node node_modules/vitest/vitest.mjs run --config apps/host/test/agent-learning-behavior.config.mts
// A private build may instead use the same source/clang flags from the original Host builder,
// then pass its absolute artifact as AGENT_LEARNING_BEHAVIOR_HELPER. Missing artifacts fail;
// they are not a reason to skip original-resource/CAS assertions.
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
if (process.env.AGENT_LEARNING_TRACE || process.env.AGENT_LEARNING_MUTANT)
  throw Error('Use only the behavior trace/mutation variables for this isolated configuration.')

export default defineConfig({ ...original,
  plugins: [...original.plugins!, { name: 'behavior-original-host-resource', enforce: 'pre', resolveId(source: string) {
    if (source === '@agentmux/host/mote-resources') return resolve(import.meta.dirname, '../src/mote-resources.ts')
    if (source === '@agentmux/host/mote-model') return resolve(import.meta.dirname, '../src/mote-model.ts')
  }, transform(source: string, id: string) {
    let served = source
    const mutation = process.env.AGENT_LEARNING_BEHAVIOR_MUTANT
    if (mutation && !['resource-boundary', 'topic-original-identity'].includes(mutation)) throw Error('Unknown behavior mutation.')
    if (mutation === 'resource-boundary' && id.endsWith('/src/main/file-read-owner.ts')) {
      const expression = "if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original File mapping changed. Read that exact file before deciding another save.', 'FILE_RESOURCE_MISMATCH')"
      if (source.split(expression).length !== 2) throw Error('Original file-write boundary changed.')
      served = source.replace(expression, '/* mutation: omit exact original write resource comparison */')
    }
    if (mutation === 'topic-original-identity' && id.endsWith('/src/main/scratch-topics.ts')) {
      const expression = 'original: await scratchDirectoryIdentity(workspace.path, topicId, await scratchDirectoryAddress(workspace.path, topicId, resolved))'
      if (source.split(expression).length !== 2) throw Error('Original Topic identity retention changed.')
      served = source.replace(expression, 'original: await scratchDirectoryIdentity(workspace.path, topicId, resolved)')
    }
    if (id.endsWith('/src/main/workspace-files.ts') && process.env.AGENT_LEARNING_BEHAVIOR_HELPER) {
      const expression = "const WORKSPACE_MOVE_HELPER = resolve(\n  import.meta.dirname,\n  '../../resources/bin/agentmux-workspace-move'\n)"
      if (source.split(expression).length !== 2) throw Error('Original native helper binding changed.')
      served = source.replace(expression, 'const WORKSPACE_MOVE_HELPER = ' + JSON.stringify(resolve(process.env.AGENT_LEARNING_BEHAVIOR_HELPER)))
    }
    if (process.env.AGENT_LEARNING_BEHAVIOR_TRACE && /\/(?:apps\/(?:host|desktop)|packages\/core)\/src\//u.test(id) && /\.[cm]?[jt]sx?$/u.test(id.split('?')[0]!)) {
      const row = JSON.stringify({ path: id.split('?')[0], originalSHA256: hash(source), servedSHA256: hash(served), helperBindingChanged: id.endsWith('/src/main/workspace-files.ts') && served !== source, mutation: ['/src/main/file-read-owner.ts', '/src/main/scratch-topics.ts'].some(path => id.endsWith(path)) && served !== source ? mutation : undefined }) + '\n'
      const prefix = "import { appendFileSync as __behaviorLoad } from 'node:fs'; __behaviorLoad(" + JSON.stringify(process.env.AGENT_LEARNING_BEHAVIOR_TRACE) + ',' + JSON.stringify(row) + ');\n'
      const shebang = served.startsWith('#!') ? served.indexOf('\n') + 1 : 0
      return { code: served.slice(0, shebang) + prefix + served.slice(shebang), map: null }
    }
    return served === source ? undefined : { code: served, map: null }
  } }],
  test: { ...original.test, include: ['apps/host/test/agent-learning-behavior.test.ts'], testTimeout: 30_000 }
})
