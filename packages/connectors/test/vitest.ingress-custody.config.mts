import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..')
const selected = process.env.INGRESS_CUSTODY_MUTATION
const mutations: Record<string, { path: string; replacements: [string, string][] }> = {
  'firstsave-not-ensured': { path: 'packages/connectors/dist/durable-ingress.js', replacements: [["if (!record.input?.admissionIntent)", 'if (record.input)']] },
  'legacy-direct-dispatch': { path: 'packages/core/dist/client.js', replacements: [
    ["if (retained && admissionIntent.kind !== 'exact-condition') {", "if (retained?.input && admissionIntent.kind !== 'exact-condition') {"],
    ["if (admissionIntent.kind !== 'exact-condition')\n            throw new AgentMuxError('The original controlled input could not be confirmed.", "if (false)\n            throw new AgentMuxError('The original controlled input could not be confirmed."] ] },
  'author-gates-saved-read': { path: 'packages/core/dist/client.js', replacements: [["if (retained && admissionIntent.kind !== 'exact-condition') {", "if (false && retained && admissionIntent.kind !== 'exact-condition') {"]] },
  'borrow-current-environment': { path: 'packages/core/dist/client.js', replacements: [['if (!sameRun(recipient.run, expectedRun) && !recovered)', 'if (false)']] },
  'action-source-cas-lost': { path: 'packages/connectors/dist/durable-ingress.js', replacements: [['if (prior) {', 'if (false) {']] },
  'wake-retries-not-applied': { path: 'packages/core/dist/client.js', replacements: [["if (input.scope === 'wake-only' && (refused || saved.control.state === 'stopped-before-dispatch'))", "if (false)"]] },
  'adopt-current-ref': { path: 'packages/connectors/dist/durable-ingress.js', replacements: [['inputRef: { key: inspection.inputReceipt.key, waitGeneration: 1 }', 'inputRef: inspection.inputReceipt.ref']] },
  'public-source-replaced': { path: 'packages/core/dist/public-rpc-service.js', replacements: [["owner.ingress.rejoin(parseConnectionParams(method, params),", "owner.ingress.rejoin({ ...parseConnectionParams(method, params), source: (await owner.ingress.inspect({ ingressId: params.ingressId })).rejoinSource },"]] }
}
if (selected && !mutations[selected]) throw Error('Unknown ingress custody mutation')
export default defineConfig({ root, cacheDir: '.cache/ingress-custody', plugins: [{
  name: 'ingress-custody-loaded-implementation', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/dist\/.+\.js$/u.test(path)) return
    let served = original
    if (selected && mutations[selected]!.path === path) for (const [before, after] of mutations[selected]!.replacements) {
      if (served.split(before).length !== 2) throw Error('Mutation needs one actual owning anchor: ' + selected + ': ' + before)
      served = served.replace(before, after)
    }
    const sha = (code: string) => createHash('sha256').update(code).digest('hex')
    if (process.env.INGRESS_CUSTODY_LOADED) {
      const row = { path, originalSHA256: sha(original), sha256: sha(served), mutation: served === original ? null : selected }
      return { code: "import { appendFileSync as __custodyLoaded } from 'node:fs'; __custodyLoaded(" + JSON.stringify(process.env.INGRESS_CUSTODY_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + served, map: null }
    }
    return served === original ? undefined : { code: served, map: null }
  }
}], test: { include: ['packages/connectors/test/ingress-custody-recovery-consumer.test.ts', 'packages/connectors/test/durable-ingress.test.ts'], fileParallelism: false, maxWorkers: 1,
  testTimeout: 20000, hookTimeout: 20000, server: { deps: { inline: [/@agentmux\/core/, /@agentmux\/connectors/] } } } })
