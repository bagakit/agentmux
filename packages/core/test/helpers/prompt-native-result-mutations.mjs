import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const leaf='packages/core/src/prompt-native-result.ts',store='packages/core/src/agent-session-store.ts',client='packages/core/src/client.ts'
export const mutations={
 'observation-gap-hides-input':[client,[["} catch (error) {\n          this.publisher.publish({ type: 'agent-error', agentSessionId: key.agentSessionId", "} catch (error) {\n          throw error; this.publisher.publish({ type: 'agent-error', agentSessionId: key.agentSessionId"]],'^an optional native observation failure'],
 'import-becomes-claim':[store,[['this.saveSession(db, session, false, false, false)', 'this.saveSession(db, session, false)']],'^physical legacy JSON import'],
 'forget-provenance-coverage':[client,[['if (nativeInputCoverage && options.cursor', 'if (options.cursor']],'^a complete cut whose normalization'],
 'refresh-unknown-result':[store,[["  if (original?.nativeResult && !finalPromptNativeResult(original.nativeResult) && !finalPromptNativeResult(next.nativeResult))\n    next.nativeResult = structuredClone(original.nativeResult)\n", '']],'^keeps unknown native outcome, original token and source after reopen'],
 'backfill-legacy-source':[store,[['if (captureNativeSource && native &&', 'if (native &&']],'^a legacy latest slot'],
 'hide-unsupported-carrier':[store,[["? original.admission.transport === 'native' ?","? true ?"]],'^a PTY ACK'],
 'drop-typed-end-reason':[client,[["...(observation.endReason === undefined ? {} : { endReason: observation.endReason }),",'']],'^a direct native ACK'],
 'complete-legacy-end':[leaf,[["if (!end?.endReason || !['completed', 'failed', 'interrupted'].includes(end.endReason))","if (!end)"],["state: end.endReason as 'completed' | 'failed' | 'interrupted'","state: (end.endReason ?? 'completed') as 'completed' | 'failed' | 'interrupted'"]],'^a legacy'],
 'borrow-other-run':[leaf,[['record.run.runId !== session.run.runId || ','']],'^the original direct ACK cannot borrow another run'],
 'borrow-other-source':[leaf,[['!sameNativeHandle(record.nativeSource.nativeHandle, source) || ','']],'^the original direct ACK cannot borrow another source'],
 'forget-complete-cut':[client,[['options.cursor === undefined && normalized.nextCursor === null && normalized.changesCursor','options.cursor === undefined && normalized.changesCursor']],'^a partial queue cut'],
 'first-nonce-wins':[leaf,[['if (candidates.length !== 1) return','if (!candidates.length) return']],'^a duplicate queue cut'],
 'adopt-edited-future':['packages/core/src/native-input-adoption.ts',[["plan.operation === 'queue-idle' && plan.expectedTurnId === undefined && frozenContent","plan.operation === 'queue-idle' && plan.expectedTurnId === undefined"]],'^a edited queue cut'],
 'overwrite-original-result':[store,[['if (finalPromptNativeResult(original?.nativeResult))','if (false)']],'^a later input'],
 'leak-private-result':['packages/core/src/public-rpc-service.ts',[["if (!input && caller && caller.agentSessionId !== key.agentSessionId && original?.admission?.intent?.message?.authorAgentSessionId !== caller.agentSessionId)","if (false)"]],'^the public participant guard'],
 'accept-foreign-result-source':['packages/core/src/prompt-submission-record.ts',[['result.sourceId !== plan.sourceId || ','']],'^the public participant guard'],
 'false-positive-on-store-failure':[client,[['await this.store.settlePromptAdmission(original, next); return next', 'void this.store.settlePromptAdmission(original, next).catch(() => {}); return next']],'^an archive settlement failure'],
 'block-original-ack-with-observation':[store,[['if (!samePromptReceiptClaim(original, expected))','if (!isDeepStrictEqual(original, expected))']],'^the actual Core input consumer and original native queued']
}
export const owners=new Set([leaf,store,client,'packages/core/src/types.ts','packages/core/src/native-input-adoption.ts','packages/core/src/prompt-submission-record.ts',
 'packages/core/src/public-rpc-service.ts','packages/core/src/rpc-native-codec.ts','packages/core/src/native-input-correlation.ts',
 'packages/core/src/providers/codex-native-input.ts', 'packages/providers/src/codex/input-protocol.ts','packages/providers/src/codex/session-status.ts', 'packages/providers/src/codex/turn-evidence.ts','packages/providers/src/codex/saved-history.ts','packages/providers/src/codex/turn-outcome.ts'])
export function instrument(code,file){
 if(!owners.has(file))return code
 const name=process.env.PROMPT_NATIVE_RESULT_MUTATION,mutation=mutations[name];if(name&&!mutation)throw Error('Unknown native result mutation')
 let output=code,edits=0
 if(mutation?.[0]===file)for(const[before,after]of mutation[1]){if(output.split(before).length!==2)throw Error('Exact current source anchor required: '+name+' '+file);output=output.replace(before,after);edits++}
 if(process.env.PROMPT_NATIVE_RESULT_LOADED){const sha=x=>createHash('sha256').update(x).digest('hex');appendFileSync(process.env.PROMPT_NATIVE_RESULT_LOADED,JSON.stringify({file,originalSHA256:sha(code),loadedSHA256:sha(output),mutation:edits?name:null,edits})+'\n')}
 return output
}
