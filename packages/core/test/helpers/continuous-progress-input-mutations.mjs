import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const leaf = 'packages/core/src/continuous-progress-input.ts', rpc = 'packages/core/src/public-rpc-schedules.ts', prefs = 'packages/core/src/mote/preferences.ts'
export const mutations = {
  'coerce-array-status': [leaf, [["typeof p.status !== 'string' || !['confirmed', 'unconfirmed'].includes(p.status)", "!['confirmed', 'unconfirmed'].includes(String(p.status))"]], 'array-coerced status'],
  'coerce-array-delivery': [leaf, [["typeof p.delivery !== 'string' || !['unconfirmed', 'not-applied', 'terminal-confirmed', 'native-admitted'].includes(p.delivery)", "!['unconfirmed', 'not-applied', 'terminal-confirmed', 'native-admitted'].includes(String(p.delivery))"]], 'array-coerced status'],
  'coerce-array-native-state': [leaf, [["typeof native.state !== 'string' || !['completed', 'failed', 'interrupted'].includes(native.state)", "!['completed', 'failed', 'interrupted'].includes(String(native.state))"]], 'array-coerced status'],
  'borrow-other-session': [leaf, [['original.agentSessionId !== key.agentSessionId || ', '']], 'mismatched SID'],
  'borrow-other-run': [leaf, [['original.run.runId !== key.expectedRun.runId ||', 'false ||']], 'mismatched record-Run'],
  'borrow-other-key': [leaf, [['!dequal(claim.inputKey, key) || ', '']], 'mismatched claim-key'],
  'borrow-another-occurrence': [leaf, [['!dequal(claim.futureIntent, reference.futureIntent)', 'false']], 'mismatched occurrence'],
  'borrow-native-run': [leaf, [['result.run.runId === key.expectedRun.runId && ', '']], 'native result from another run'],
  'pty-ack-completes-input': [leaf, [["nativeResult = { state: 'unsupported' }", "{ nativeResult = { state: 'completed', observedAt: 1600 }; delivery = 'native-admitted' }"]], 'a PTY byte ACK'],
  'idle-completes-input': [leaf, [['const result = original.nativeResult', "const result = original.nativeResult; if (original.semanticIdle) nativeResult = { state: 'completed', observedAt: original.semanticIdle.observedAt }"]], 'returned idle is distinct'],
  'leak-native-receipt': [leaf, [['nativeResult = { state: result.state, observedAt: result.observedAt,', 'nativeResult = { ...result, state: result.state, observedAt: result.observedAt,']], 'never exposes the private'],
  'accept-other-source': [rpc, [['!sameAutomaticInputSource(reference.managedSource, p.managedSource as AutomaticInputSource | undefined)', 'false']], 'codecs reject an input reading'],
  'accept-other-definition': [rpc, [['!definitions.some(item => item.intentId === reference.futureIntent.intentId && item.operationId === reference.definitionOperationId)', 'false']], 'codecs reject an input reading'],
  'accept-stale-reading': [leaf, [['expectedReference && !dequal(reference, parseContinuousProgressInputReference(expectedReference))', 'false']], 'same loop cannot return'],
  'redirect-to-current-definition': [rpc, [['const definitions = [\n      { intentId: p.currentDefinition ? parseContinuousProgressDefinition(p.currentDefinition).baseIntentId : p.futureIntentId, operationId: p.creationOperationId },', 'const definitions = [']], 'current definition change retains'],
  'pair-current-intent-with-creation': [rpc, [['p.currentDefinition ? parseContinuousProgressDefinition(p.currentDefinition).baseIntentId : p.futureIntentId', 'p.futureIntentId']], 'current definition change retains'],
  'drop-preferences-reading': [prefs, [['{ input: parseContinuousProgressInputReading(value.input, schedule!.lastInputRef!) }', '{}']], 'actual schedule and Mote preference codecs'],
  'accept-private-reading-field': [leaf, [["['reference', 'status', 'delivery', 'nativeResult', 'returnedIdle']", "['reference', 'status', 'delivery', 'nativeResult', 'returnedIdle', 'fullClaim']"]], 'safe reading decoder rejects private']
}
export const owners = new Set([leaf, rpc, prefs, 'packages/core/src/continuous-progress-scheduler.ts'])
export function instrument(code, file) {
  if (!owners.has(file)) return code
  const name = process.env.CONTINUOUS_PROGRESS_INPUT_MUTATION, mutation = mutations[name]
  if (name && !mutation) throw Error('Unknown original-input projection mutation')
  let output = code, edits = 0
  if (mutation?.[0] === file) for (const [before, after] of mutation[1]) {
    if (output.split(before).length !== 2) throw Error('Exact current source anchor required: ' + name)
    output = output.replace(before, after); edits++
  }
  if (process.env.CONTINUOUS_PROGRESS_INPUT_LOADED) {
    const sha = x => createHash('sha256').update(x).digest('hex')
    appendFileSync(process.env.CONTINUOUS_PROGRESS_INPUT_LOADED, JSON.stringify({ file, originalSHA256: sha(code), loadedSHA256: sha(output), mutation: edits ? name : null, edits }) + '\n')
  }
  return output
}
