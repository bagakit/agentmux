import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = native.root!
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'preparation-reason-drop': { path: 'packages/connectors/src/durable-ingress.ts', before: 'this.write({ ...current, code })', after: 'this.write(current)' },
  'diagnosis-owner-disconnect': { path: 'packages/connectors/src/connection-services.ts', before: 'return await owner.diagnose(input, context)', after: "throw new AgentMuxError('The diagnostic owner is disconnected.', 'CONTROL_UNAVAILABLE')" },
  'profile-disconnect': { path: 'apps/host/src/mote-resources.ts', before: 'const context = validProfile ? profileAgentContext(', after: 'const context = false ? profileAgentContext(' },
  'target-disconnect': { path: 'apps/host/src/mote-resources.ts', before: 'space.spaceId === target.spaceId', after: 'space.kind === \'mote\'' },
  'executor-substitution': { path: 'apps/host/src/mote-chat-agents.ts', before: '.filter(entry => entry.executorId === executorId)', after: '.slice(0, 1)' },
  'context-disconnect': { path: 'apps/host/src/mote-chat-agents.ts', before: 'optionalContext: structuredClone(prepared.optionalContext)', after: 'optionalContext: []' },
  'history-disconnect': { path: 'packages/connectors/src/mote-chat.ts', before: 'recent.length ? recent.map(g =>', after: 'recent.length ? recent.slice(0, 0).map(g =>' },
  'quota-disconnect': { path: 'packages/connectors/src/mote-chat.ts', before: 'person.person.used >= person.person.total!', after: 'false' },
  'duplicate-create': { path: 'packages/connectors/src/mote-chat.ts', before: 'if (row.dispatched) result = await this.options.agents.inspect', after: 'if (false) result = await this.options.agents.inspect' },
  'revision-disconnect': { path: 'apps/host/src/mote-chat-agents.ts', before: 'prepared.executorRevision && session.creation?.executorRevision !== prepared.executorRevision', after: 'false && session.creation?.executorRevision !== prepared.executorRevision' },
  'launch-scope-disconnect': { path: 'packages/connectors/src/mote-chat-store.ts', before: 'Object.keys(value.input).some(key =>', after: 'false && Object.keys(value.input).some(key =>' },
}
const name = process.env.MOTE_HOST_MUTANT, change = name ? mutations[name] : undefined
if (name && !change) throw Error('Unknown owning Mote Host mutation')
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/mote-host'), plugins: [{ name: 'host-mote-loaded-source', enforce: 'pre',
  resolveId(source) { if (source.startsWith('@agentmux/host/')) return resolve(root, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts') },
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let loaded = original
    if (change?.path === path) {
      if (original.split(change.before).length !== 2) throw Error('Exact owning Mote mutation must load once')
      loaded = original.replace(change.before, change.after)
    }
    if (process.env.MOTE_HOST_LOADED && /^(apps\/host\/src|apps\/desktop\/src\/(main\/(mote-chat-agents|scratch-topics)|shared\/)|packages\/(core|connectors)\/src)/u.test(path)) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.MOTE_HOST_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(change?.path === path ? { mutation: name } : {}) }) + '\n')
    }
    if (loaded !== original) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: [
  'packages/connectors/test/mote-chat-headless-journey.integration.test.ts',
  'packages/connectors/test/mote-chat-diagnosis.integration.test.ts',
  'packages/connectors/test/mote-chat-desktop-journey.integration.test.ts',
  'apps/desktop/test/mote-chat-agents-consumer.test.ts',
  'apps/desktop/test/scratch-topics.test.ts'
], setupFiles: [resolve(root, 'vitest.setup.ts')], testTimeout: 20000 } })
