import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const variants = {
  'erase-confirmed-defaults': ['apps/host/src/mote-quick-preferences.ts', "status: 'unconfirmed', source, defaults, choices: empty", "status: 'unconfirmed', source, defaults: null, choices: empty", 'observation retains the saved Executor choice'],
  'discard-partial-default-choice': ['packages/core/src/public-rpc-service.ts', 'const executorId=preference.defaults.executorId', "const executorId=preference.status==='ready'?preference.defaults.executorId:undefined", 'observation retains the saved Executor choice'],
  'ignore-executor-change': ['packages/core/src/public-rpc-service.ts', 'if(session.executorId!==executorId) {', 'if(false) {', 'changing default Executor lazily rotates'],
  'skip-original-run': ['packages/core/src/public-rpc-service.ts', 'if(queryInputKey.agentSessionId!==session.agentSessionId||queryInputKey.expectedRun.runId!==session.run.runId)', 'if(false)', 'a stale original Run'],
  'skip-original-producer-at-open': ['packages/core/src/public-rpc-service.ts', 'if(routed||original.input||original.record)', 'if(false)', 'a Query accepted by its original producer after'],
  'swallow-required-executor-unknown': ['packages/core/src/public-rpc-service.ts', "if(error instanceof AgentMuxError&&['MOTE_MAIN_EXECUTOR_UNCONFIRMED','MOTE_MAIN_CHANGED'].includes(error.code))", 'if(false)', 'original Executor comparison'],
  'skip-query-key-validation': ['packages/core/src/mote/main-period.ts', 'if(p.queryInputKey!==undefined) {', 'if(false) {', 'changing default Executor lazily rotates'],
  'accept-wrong-query-key': ['packages/core/src/mote/dialogue-contract.ts', "||!dequal(d.queryInputKey,{kind:'prompt',agentSessionId:q.input.agentSessionId,expectedRun:q.input.expectedRun,submissionId:q.input.operationId})", '', 'changing default Executor lazily rotates']
}
export function instrument(source, path) {
  if (!['packages/core/src/public-rpc-service.ts','packages/core/src/mote/main-period.ts','packages/core/src/spatial-agent-open-contract.ts','packages/core/src/mote/dialogue-contract.ts','apps/host/src/mote-quick-preferences.ts'].includes(path)) return source
  const original = source, name = process.env.MOTE_EXECUTOR_ROLLOVER_MUTANT, mutation = name && variants[name]
  if (name && !mutation) throw Error('Unknown Executor rollover mutation')
  if (mutation?.[0] === path) {
    if (source.split(mutation[1]).length !== 2) throw Error('Executor rollover mutation requires one exact production anchor: ' + name)
    source = source.replace(mutation[1],mutation[2])
  }
  if (process.env.MOTE_EXECUTOR_ROLLOVER_LOADED) {
    const hash = value => createHash('sha256').update(value).digest('hex'), row = { path, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutation: name }) }
    source = `import { appendFileSync as __rolloverLoaded } from 'node:fs'; __rolloverLoaded(${JSON.stringify(process.env.MOTE_EXECUTOR_ROLLOVER_LOADED)},${JSON.stringify(JSON.stringify(row)+'\n')});\n` + source
  }
  return source
}
