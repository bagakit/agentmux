import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, { file: string; anchors: Array<[string, string]> }> = {
  'old-parser': { file: '/core/dist/room-binding-codec.js', anchors: [['appId: nativeIdentity(p.appId)', 'appId: id(p.appId)']] },
  'lost-scope': { file: '/core/dist/connections-contract.js', anchors: [['application.issuer === undefined ? application.domain : JSON.stringify([application.domain, application.issuer])', 'application.domain']] },
  'grant-scope': { file: '/connectors/src/application-access.ts', anchors: [['connectionApplicationScope(config.application)', 'config.application.domain'], ['connectionApplicationScope(g.actor.application)', 'g.actor.application.domain']] },
  'profile-scope': { file: '/connectors/dist/connection-profile.js', anchors: [[" AND json_extract(record_json,'$.application.issuer') IS ?", ''], ['application.appId, application.issuer ?? null)', 'application.appId)']] },
  'audience-index': { file: '/connectors/src/mote-chat-store.ts', anchors: [["json_extract(snapshot_json,'$.generation.application.issuer'),json_extract(snapshot_json,'$.generation.externalConversationId'),sequence DESC)", "json_extract(snapshot_json,'$.generation.externalConversationId'),sequence DESC)"], ["json_extract(snapshot_json,'$.generation.application.issuer'),json_extract(snapshot_json,'$.generation.externalConversationId'));", "json_extract(snapshot_json,'$.generation.externalConversationId'));" ]] },
  'context-index': { file: '/connectors/src/publication-store.ts', anchors: [["        json_extract(operation_json,'$.target.application.issuer'),\n", '']] },
  'intake-scope': { file: '/connectors/dist/durable-ingress.js', anchors: [['.all(connectionApplicationScope(application), application.appId, bound, limit + 1)', '.all(application.domain, application.appId, bound, limit + 1)'],
    ['.get(connectionApplicationScope(application), application.appId, after, cap + 1)', '.get(application.domain, application.appId, after, cap + 1)'],
    ["app_id=?').get(connectionApplicationScope(application), application.appId)", "app_id=?').get(application.domain, application.appId)"]] }
}
export default defineConfig({ root, cacheDir: resolve(root, '.cache/application-issuer'), plugins: [{
  name: 'application-issuer-loaded-mutation', enforce: 'pre',
  transform(code, id) {
    const mutation = process.env.APPLICATION_ISSUER_MUTANT, mutant = mutation ? mutants[mutation] : undefined
    if (!mutant || !id.endsWith(mutant.file)) return
    if (mutant.anchors.some(([old]) => !code.includes(old))) throw new Error('APPLICATION_ISSUER_MUTANT_ANCHOR_MISSING: ' + mutation)
    process.stderr.write('APPLICATION_ISSUER_MUTANT_LOADED: ' + mutation + '\n')
    return mutant.anchors.reduce((next, [old, replacement]) => next.replace(old, replacement), code)
  }
}], test: { include: ['packages/connectors/test/application-issuer-consumer.test.ts', 'packages/connectors/test/mote-chat-owner.test.ts', 'packages/connectors/test/publication-context.test.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 30000, server: { deps: { inline: [/@agentmux\/core/, /@agentmux\/connectors/] } } } })
