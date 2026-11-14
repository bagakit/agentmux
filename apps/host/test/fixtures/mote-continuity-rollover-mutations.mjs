import { createHash } from 'node:crypto'
const sources = new Set(['packages/core/src/mote/main-period.ts','packages/core/src/public-rpc-service.ts','packages/core/src/mote/dialogue-contract.ts','packages/core/src/spatial-agent-open.ts','packages/core/src/mote/main-setup.ts','packages/core/src/agentmux-cli-commands.ts','apps/host/src/mote-dialogue.ts','apps/host/src/mote-quick-preferences.ts','apps/host/src/spatial-agent-control.ts','apps/host/test/helpers/mote-conversation-start-fixture.ts'])
const service = 'packages/core/src/public-rpc-service.ts'
export const mutations = {
  'source-clock-ordered': ['packages/core/src/mote/main-period.ts', '!Number.isSafeInteger(evidence.observedAt)||Number(evidence.observedAt)<0)', '!Number.isSafeInteger(evidence.observedAt)||Number(evidence.observedAt)<0||Number(evidence.observedAt)>Number(p.evaluatedAt))', '^a source Host clock ahead'],
  'unavailable-path-removed': [service, "if(originalMain&&original&&continuity?.kind==='unavailable'", "if(false&&originalMain&&original&&continuity?.kind==='unavailable'", '^the exact unavailable owner'],
  'automatic-opt-in-forgotten': [service, 'const policy=preference.defaults.conversationRollover', "const policy={kind:'idle' as const,idleMs:86400000}", 'keep-current never|unconfigured never'],
  'fresh-ended-forgotten': [service, "['exited','interrupted'].includes(observed.run.state)", 'true', '^fresh-running cannot'],
  'fresh-native-forgotten': [service, '!current.nativeHandle&&!current.observedNativeHandle&&!current.nativeSourceObservation&&', '', '^fresh-native cannot'],
  'unknown-start-forgotten': [service, '!Object.values(current.continuityOperations??{}).some(operation=>operation.previousRun.runId===queryInputKey.expectedRun.runId&&unconfirmedMoteMainEntryOperation(operation))', 'true', '^unknown-start cannot'],
  'old-route-forgotten': [service, 'let route = await journal.readMoteMainInputRoute(main.identity,operationId)', 'let route = submit ? null : await journal.readMoteMainInputRoute(main.identity,operationId)', '^the exact unavailable owner'],
  'creation-revalidation-forgotten': [service, 'const decision=main&&await this.evaluateMoteRollover(main,key,journal,context)', "const decision={status:'due',decision:intent.rollover}", '^creation rejects a decision after the original native changes']
}
export function instrumentPolicy(source, file) {
  if (!sources.has(file)) return source
  let loaded = source
  const name = process.env.MOTE_POLICY_MUTATION, mutation = name && mutations[name]
  if (name && !mutation) throw Error('Unknown exact policy mutation')
  if (mutation?.[0] === file) { if (source.split(mutation[1]).length !== 2) throw Error('Exact policy mutation anchor required: ' + name); loaded = source.replace(mutation[1], mutation[2]) }
  if (!process.env.MOTE_POLICY_LOADED) return loaded
  const sha = value => createHash('sha256').update(value).digest('hex'), row = JSON.stringify({ file, originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: loaded === source ? null : name }) + '\n'
  return "import {appendFileSync as __policyLoaded} from 'node:fs';\n__policyLoaded(" + JSON.stringify(process.env.MOTE_POLICY_LOADED) + ',' + JSON.stringify(row) + ');\n' + loaded
}
