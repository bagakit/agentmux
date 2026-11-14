import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import base from './renderer-hosting-continuation.config.mts'
const owner = base.plugins![0] as Plugin
const mutations: Record<string, [string, string, string]> = {
  'malformed-issuer': ['apps/host/src/mote-quick-mode.ts', "if (app.has('issuer') && !isScalar(app.get('issuer', true))) return { status: 'unconfirmed', message: ISSUE }", ''],
  default: ['apps/desktop/src/renderer/src/lib/mote-connection-default.ts', '!sameConnectionApplication(record.config.application, ref.application)', 'record.config.application.domain !== ref.application.domain || record.config.application.appId !== ref.application.appId'],
  member: ['apps/desktop/src/renderer/src/lib/connector-member-draft.ts', ', ...(actor.application.issuer === undefined ? [] : [actor.application.issuer])', ''],
  locator: ['apps/desktop/src/renderer/src/lib/bot-task-selection.ts', 'sameConnectionApplication({ domain: scope.domain, appId: scope.appId, ...(scope.issuer === undefined ? {} : { issuer: scope.issuer }) }, record.config.application)', 'scope.domain === record.config.application.domain && scope.appId === record.config.application.appId'],
  observation: ['apps/desktop/src/renderer/src/components/ConnectorMemberAccess.tsx', 'sameConnectionApplication(item.actor.application, value.application) && item.actor.idType', 'item.actor.idType'],
  removal: ['apps/desktop/src/renderer/src/components/settings/ConnectionIdentityRemoval.tsx', '!sameConnectionApplication(current.config.application, originalApplication)', 'false'],
  speaker: ['packages/client-ui/src/lib/conversation-speaker.ts', 'sameConnectionApplication(room.application, author.actor.application)', 'room.application.domain === author.actor.application.domain && room.application.appId === author.actor.application.appId']
}
const selected = process.env.ISSUER_CLIENT_MUTANT
if (selected && !mutations[selected]) throw Error('Unknown issuer mutant')
export default defineConfig({ ...base, plugins: [{ name: 'issuer-client-alias', enforce: 'pre', resolveId(source) { if (source === '@agentmux/client-ui/conversation-speaker') return resolve(base.root!, 'packages/client-ui/src/lib/conversation-speaker.ts') } }, { name: 'issuer-client-source', enforce: 'pre', resolveId: owner.resolveId,
  transform(source, id) {
    const path = relative(base.root!, id.split('?')[0]!), mutant = selected ? mutations[selected] : undefined
    let loaded = source
    if (mutant && path === mutant[0]) { if (!source.includes(mutant[1])) throw Error('Mutant source anchor absent'); loaded = source.replace(mutant[1], mutant[2]) }
    if (process.env.ISSUER_CLIENT_LOADED && (path.startsWith('apps/desktop/src/renderer/src/') || path.startsWith('packages/client-ui/src/') || path === 'apps/host/src/mote-quick-mode.ts')) {
      const sha = (s: string) => createHash('sha256').update(s).digest('hex')
      appendFileSync(process.env.ISSUER_CLIENT_LOADED, JSON.stringify({ path, original: sha(source), loaded: sha(loaded), mutation: loaded === source ? null : selected }) + '\n')
    }
    return loaded === source ? undefined : loaded
  }
}], test: { ...base.test, include: ['apps/desktop/test/native-issuer-client.test.tsx'], fileParallelism: false, passWithNoTests: false } })
