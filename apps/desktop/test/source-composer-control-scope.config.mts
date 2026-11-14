import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string][]> = {
  'observer-session': [['AgentSessionComposer.tsx', '!source && explicitSession === undefined ? sessionPresentationById(state.sessions).get(sessionId)', 'explicitSession === undefined ? sessionPresentationById(state.sessions).get(sessionId)']],
  'observer-mailbox': [['AgentSessionComposer.tsx', 'control={source ? null : session?.kind === \'agent\' ? session.control : undefined}', 'control={session?.kind === \'agent\' ? session.control : undefined}']],
  'observer-automation': [['AgentSessionComposer.tsx', 'progressSession={!source && !readOnly', 'progressSession={!readOnly']],
  'observer-image': [['AgentSessionComposer.tsx', "sessionControl: !source && session?.kind === 'agent'", "sessionControl: session?.kind === 'agent'"], ['AgentSessionComposer.tsx', 'hostId: source ? undefined : session?.hostId', 'hostId: session?.hostId']],
  'observer-resource': [['AgentSessionComposer.tsx', 'config?.workspaces.find(item => item.id === resourceWorkspaceId)', 'config?.workspaces.find(item => item.hostId === session?.hostId && item.path === session?.workspacePath)']],
  'observer-skills': [['AgentSessionComposer.tsx', "loadSkills={source ? async () => { throw new Error('Original Agent Skills are unavailable through this member connection. Your draft is kept; open the original Agent workface to inspect them.') } : completion.loadSkills}", 'loadSkills={completion.loadSkills}'], ['AgentSessionComposer.tsx', 'sessionId: source ? undefined : sessionId', 'sessionId']],
  'mailbox-fallback': [['SessionMailbox.tsx', 'propControl !== undefined ? undefined', 'propControl ? undefined'], ['SessionMailbox.tsx', 'propControl === null ? undefined : propControl ??', 'propControl ??']]
}
const mutation = process.env.AGENTMUX_SOURCE_CONTROL_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known original Source control mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/source-composer-control', mutation ?? 'control'), plugins: [...base.plugins ?? [], {
  name: 'original-source-control-proof', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['AgentSessionComposer.tsx', 'SessionMailbox.tsx'].some(file => path.endsWith(`/components/${file}`))) return
    let loaded = original
    for (const [file, from, to] of mutation ? mutations[mutation]! : []) if (path.endsWith(`/components/${file}`)) {
      assert.equal(loaded.split(from).length - 1, 1, `Unique Source control mutation anchor: ${mutation}`)
      loaded = loaded.replace(from, to)
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_SOURCE_CONTROL_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_CONTROL_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded), mutated: loaded !== original, mutation: loaded !== original ? mutation : null }) + '\n')
    if (loaded !== original) return { code: loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/source-composer-control-scope.test.tsx'], setupFiles: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
