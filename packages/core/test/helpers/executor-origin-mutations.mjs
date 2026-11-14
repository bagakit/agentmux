import { createHash } from 'node:crypto'
export const originMutants={
 'wide-metadata-read':['packages/core/src/client.ts','value = await this.store.readExecutorInvocation(historyAgentSessionId)','value = (await this.store.readMetadata(historyAgentSessionId))?.executorInvocation'],
 'capture':['packages/core/src/client.ts',"const executorInvocation = admitted?.executorRevision ? undefined : captureExecutorInvocation(input.providerId, executorId, createOperationId, intentDigest, input)",'const executorInvocation = undefined'],
 'read-original':['packages/core/src/client.ts',"if (!targetOwned && session.creation?.executorInvocationDigest && (!explicit || historyAgentSessionId !== undefined))",'if (false)'],
 'partial-overrides':['packages/core/src/client.ts','return { ...input, commandOverride: original.options.commandOverride, args: original.options.args, env: original.options.env } as T','return { ...input, ...structuredClone(original.options) } as T'],
 'public-secret':['packages/core/src/agent-session-identity.ts','executorInvocation: _invocation, ',''],
 'digest':['packages/core/src/agent-executor-invocation.ts','if (digest(normalized) !== owner.creation.executorInvocationDigest)','if (false)'],
 'owner':['packages/core/src/agent-executor-invocation.ts','executor.providerId !== owner.providerId || executor.executorId !== owner.executorId','false'],
 'resume-source':['packages/core/src/agent-session-recovery/continuity-attempt.ts',"else if (executor.source === 'creation') input = await ports.executors.sessionExecutorOptions(current, originalInput)","else if (executor.source === 'creation') input = originalInput"],
 'retirement-source':['packages/core/src/agent-session-store.ts','...(previous.executorInvocation === undefined ? {} : { executorInvocation: structuredClone(previous.executorInvocation) }),',''],
 'prepared-source':['packages/core/src/agent-session-store.ts','...(p.executorInvocation === undefined ? {} : { executorInvocation: structuredClone(p.executorInvocation) }),','']
}
export function instrumentOrigin(original,path,surface){
 const name=process.env.EXECUTOR_ORIGIN_MUTANT, report=process.env.EXECUTOR_ORIGIN_LOADED
 if(name&&!Object.hasOwn(originMutants,name))throw Error('Unknown original invocation mutant')
 const selected=name&&originMutants[name];let source=original
 if(selected&&path===selected[0]){
  const count=source.split(selected[1]).length-1,expected=name==='retirement-source'?2:1
  if(count!==expected)throw Error('Mutation must match exact production owner: '+name+' '+count)
  source=source.replaceAll(selected[1],selected[2])
 }
 const owned=/^packages\/core\/src\/(client|agent-executor-invocation|agent-session-store|agent-session-identity|rpc-native-codec|agent-session-recovery\/(continuity-attempt|executor|lifecycle))\.ts$/u.test(path)||/^apps\/host\/src\/(host|spatial-agent-control|mote-resources)\.ts$/u.test(path)
 if(report&&owned){const sha=s=>createHash('sha256').update(s).digest('hex'),fact={path,surface,originalSHA256:sha(original),loadedSHA256:sha(source),...(source!==original?{mutant:name}:{})};source="import { appendFileSync as __originFact } from 'node:fs'; __originFact("+JSON.stringify(report)+', '+JSON.stringify(JSON.stringify(fact)+'\n')+');\n'+source}
 return source
}
