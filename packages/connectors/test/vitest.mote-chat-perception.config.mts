import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = native.root!
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'member-gate': { path: 'packages/connectors/src/mote-chat.ts', before: "if (!member) fail('CONTROL_PERMISSION_DENIED'", after: "if (false) fail('CONTROL_PERMISSION_DENIED'" },
  'serving-agent-gate': { path: 'packages/connectors/src/mote-chat.ts', before: 'if (hostId && this.store.generationBySession(agentSessionId)?.generation.executionHostId === hostId)', after: 'if (false)' },
  'generation-host': { path: 'packages/connectors/src/mote-chat.ts', before: '?.generation.executionHostId === hostId)', after: ')' },
  'bound-agent-gate': { path: 'packages/connectors/src/mote-chat.ts', before: 'if (relationship) fail(', after: 'if (false) fail(' },
  'relationship-host': { path: 'packages/connectors/src/mote-chat.ts', before: 'list({ agentSessionId, executionHostId: hostId })', after: 'list({ agentSessionId })' },
  'cursor-scope': { path: 'packages/connectors/src/mote-chat.ts', before: "scope = ['events', input.target, order, application]", after: "scope = ['events', input.target]" },
  'mark-regression': { path: 'packages/connectors/src/mote-chat.ts', before: 'if (current && current.through >= input.through) return current', after: 'if (false) return current' },
  'application-scope': { path: 'packages/connectors/src/durable-ingress.ts', before: "FROM connection_ingress_message WHERE domain=? AND app_id=? AND sequence${backward ? '<' : '>'}?", after: "FROM connection_ingress_message WHERE ?<>'' AND ?<>'' AND sequence${backward ? '<' : '>'}?" },
  'zone-membership': { path: 'apps/host/src/mote-membership.ts', before: 'tab.zoneId !== null && zones.has(tab.zoneId)', after: 'true' },
  'region-host': { path: 'apps/host/src/mote-membership.ts', before: ' && region.execution?.hostId === agent.hostId', after: '' },
  'application-index': { path: 'packages/connectors/src/durable-ingress.ts', before: 'CREATE INDEX IF NOT EXISTS connection_ingress_message_application ON connection_ingress_message(domain,app_id,sequence);', after: '' }
}
const name = process.env.MOTE_PERCEPTION_MUTANT, change = name ? mutations[name] : undefined
if (name && !change) throw Error('Unknown Mote perception mutation')
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/mote-chat-perception'), plugins: [{
  name: 'mote-perception-loaded-source', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let loaded = original
    if (change?.path === path) {
      if (original.split(change.before).length !== 2) throw Error('Exact Mote perception mutation must load once')
      loaded = original.replace(change.before, change.after)
    }
    if (process.env.MOTE_PERCEPTION_LOADED && path.endsWith('.ts') && /^(packages\/(core|connectors)\/src|apps\/host\/src)\//u.test(path)) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded !== original ? { mutation: name } : {}) }
      return { code: "import { appendFileSync as __perceptionLoaded } from 'node:fs'; __perceptionLoaded(" + JSON.stringify(process.env.MOTE_PERCEPTION_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (loaded !== original) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: [
  'packages/connectors/test/mote-chat-perception.test.ts',
  'apps/host/test/mote-chat-membership.test.ts',
  'packages/core/test/mote-chat-perception-contract.test.ts'
] } })
