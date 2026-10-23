import { defineConfig } from 'vitest/config'
import original from './agent-learning.config.mts'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...original,
  plugins: [...original.plugins!, { name: 'behavior-original-host-resource', enforce: 'pre', resolveId(source: string) {
    if (source === '@agentmux/host/mote-resources') return resolve(import.meta.dirname, '../src/mote-resources.ts')
    if (source === '@agentmux/host/mote-model') return resolve(import.meta.dirname, '../src/mote-model.ts')
  }, transform(source: string, id: string) {
    let served = source
    const mutation = process.env.AGENT_LEARNING_BEHAVIOR_MUTANT
    if (mutation && mutation !== 'resource-boundary') throw Error('Unknown behavior mutation.')
    if (mutation === 'resource-boundary' && id.endsWith('/src/main/file-read-owner.ts')) {
      const expression = "if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original File mapping changed. Read that exact file before deciding another save.', 'FILE_RESOURCE_MISMATCH')"
      if (source.split(expression).length !== 2) throw Error('Original file-write boundary changed.')
      served = source.replace(expression, '/* mutation: omit exact original write resource comparison */')
    }
    if (id.endsWith('/src/main/workspace-files.ts') && process.env.AGENT_LEARNING_BEHAVIOR_HELPER) {
      const expression = "const WORKSPACE_MOVE_HELPER = resolve(\n  import.meta.dirname,\n  '../../resources/bin/agentmux-workspace-move'\n)"
      if (source.split(expression).length !== 2) throw Error('Original native helper binding changed.')
      served = source.replace(expression, 'const WORKSPACE_MOVE_HELPER = ' + JSON.stringify(resolve(process.env.AGENT_LEARNING_BEHAVIOR_HELPER)))
    }
    if (process.env.AGENT_LEARNING_BEHAVIOR_TRACE && /\/(?:apps\/(?:host|desktop)|packages\/core)\/src\//u.test(id))
      appendFileSync(process.env.AGENT_LEARNING_BEHAVIOR_TRACE, JSON.stringify({ path: id.split('?')[0], originalSHA256: hash(source), servedSHA256: hash(served), helperBindingChanged: id.endsWith('/src/main/workspace-files.ts') && served !== source, mutation: id.endsWith('/src/main/file-read-owner.ts') && served !== source ? mutation : undefined }) + '\n')
    return served === source ? undefined : { code: served, map: null }
  } }],
  test: { ...original.test, include: ['apps/host/test/agent-learning-behavior.test.ts'], testTimeout: 30_000 }
})
