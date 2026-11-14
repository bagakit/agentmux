export const heartbeatSourceMutants = [
  { id: 'reference-not-retained', file: 'apps/host/src/continuous-progress-loop-manager.ts', from: 'pendingCompletion: pending, ...(lastInputRef ? { lastInputRef } : {})', to: 'pendingCompletion: pending', test: 'real due delivery' },
  { id: 'inspection-drops-input-result', file: 'apps/host/src/continuous-progress-loop-manager.ts', from: 'schedule, ...(input ? { input } : {})', to: 'schedule', test: 'real due delivery' },
  { id: 'foreign-pointer-reads-private-archive', file: 'apps/host/src/scheduled-input-source.ts', from: 'if (reference.inputKey.agentSessionId !== loop.agentSessionId || !sameAutomaticInputSource(reference.managedSource, loop.managedSource) ||\n        scheduledDefinitionOperation(loop, reference.futureIntent.intentId) !== reference.definitionOperationId)', to: 'if (false)', test: 'a foreign stored pointer' },
  { id: 'frozen-platform-context-not-checked', file: 'apps/host/src/scheduled-input-source.ts', from: 'message.userContent !== intent.message.userContent || message.systemContext !== intent.message.systemContext', to: 'message.userContent !== intent.message.userContent', test: 'a foreign stored pointer' },
  { id: 'neighbor-occurrence-qualifies-report', file: 'apps/host/src/scheduled-input-source.ts', from: '!isDeepStrictEqual(admission.futureIntent, reference.futureIntent) || ', to: '', test: 'the report source qualifier' },
  { id: 'foreign-run-reads-report-source', file: 'apps/host/src/mote-presence.ts', from: ' || !isDeepStrictEqual(caller.run, source.inputKey.expectedRun) || !context.readInput', to: ' || !context.readInput', test: 'the report source qualifier' },
]
export function instrumentHeartbeatSource(code, file) {
  const m = heartbeatSourceMutants.find(value => value.id === process.env.MOTE_SOURCE_MUTANT && value.file === file)
  if (!m) return code
  if (code.split(m.from).length !== 2) throw Error('Heartbeat source mutant drift: ' + m.id)
  return code.replace(m.from, m.to)
}
