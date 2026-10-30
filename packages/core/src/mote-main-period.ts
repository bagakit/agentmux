import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConversationCheckpoint, type ConversationCheckpoint } from './conversation-changes.js'
import { parseMoteDefaultConversation, parseMotePreferencesTarget, parseMoteQuickDefaults } from './mote-preferences.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { dequal } from 'dequal'
import type { MotePreferencesTarget, MoteDefaultConversation, MoteMainRolloverPolicy } from './mote-preferences.js'
import type { AgentMuxRunRef } from './types.js'
import type { AgentPromptInputKey } from './agent-prompt-condition.js'

export type MoteMainTransitionCause = { kind:'initial' | 'manual-takeover' | 'selection' | 'clear'; operationId:string }
  | { kind:'automatic'; operationId:string; decision:MoteMainRolloverDecision }
export type MoteMainPeriod = { id:string; roleRevision:string; reference:MoteDefaultConversation;
  startedAt:number|null; endedAt:number|null; start:MoteMainTransitionCause|null; end:MoteMainTransitionCause|null;
  range:{kind:'bounded';after:ConversationCheckpoint;through:ConversationCheckpoint|null} | {kind:'unconfirmed';issue:string} | {kind:'whole-session'} }
export type MoteMainRolloverDecision = { target:MotePreferencesTarget; expectedRoleRevision:string; reference:MoteDefaultConversation;
  policyRevision:string; policy:Extract<MoteMainRolloverPolicy,{kind:'idle'}>; activity:{inputKey:AgentPromptInputKey;run:AgentMuxRunRef;sourceId:string;sequence:number;idleSince:number};
  evaluatedAt:number; queryOperationId:string; creationOperationId:string }
export type MoteMainRolloverReading = {status:'keep-current'|'not-due'|'due'|'unconfirmed';decision:MoteMainRolloverDecision|null;issue:string|null}
export function parseMoteMainPeriod(value: unknown): MoteMainPeriod {
 const p=rpcRecord(value,['id','roleRevision','reference','startedAt','endedAt','start','end','range'],'CONTROL_PROTOCOL_ERROR')
 parseMoteDefaultConversation(p.reference,'CONTROL_PROTOCOL_ERROR')
 for(const field of ['start','end'])if(p[field]!==null)parseMoteMainTransitionCause(p[field])
 for(const key of ['id','roleRevision']) if(typeof p[key]!=='string'||!p[key]) throw new AgentMuxError('Original Main period identity is invalid.','CONTROL_PROTOCOL_ERROR')
 for(const key of ['startedAt','endedAt']) if(p[key]!==null&&(!Number.isSafeInteger(p[key])||Number(p[key])<0)) throw new AgentMuxError('Original Main period time is unconfirmed.','CONTROL_PROTOCOL_ERROR')
 const r=rpcRecord(p.range,['kind','after','through','issue'],'CONTROL_PROTOCOL_ERROR')
 if(r.kind==='bounded') { const ref=p.reference as MoteDefaultConversation;const target={hostId:ref.hostId,agentSessionId:ref.sessionId};parseConversationCheckpoint(r.after,target);if(r.through!==null){parseConversationCheckpoint(r.through,target);const a=r.after as ConversationCheckpoint,b=r.through as ConversationCheckpoint;if(a.sourceHostId!==b.sourceHostId||!dequal(a.frontier.scope,b.frontier.scope))throw new AgentMuxError('The original period boundaries name different source scopes.','CONTROL_PROTOCOL_ERROR')} }
 else if(r.kind!=='whole-session'&&(r.kind!=='unconfirmed'||typeof r.issue!=='string'||!r.issue))throw new AgentMuxError('The original Main source range is invalid.','CONTROL_PROTOCOL_ERROR')
 return p as MoteMainPeriod
}

export type MoteMainTransitionPreparation = {
 identity:import('./mote-dialogue.js').MoteDialogueIdentity;
 marker:import('./mote-preferences.js').MoteMainTransitionMarker;
 before:{roleRevision:string|null;reference:MoteDefaultConversation|null;file?:{resource:import('./public-rpc-files.js').FileReadResource;revision:string}};
 after:{roleRevision:string;reference:MoteDefaultConversation|null};
 beforeCut:ConversationCheckpoint|null;afterCut:ConversationCheckpoint|null;afterQualified?:boolean;
 cause:MoteMainTransitionCause;issue:string|null
}

export function parseMoteMainRolloverDecision(value:unknown,code:'INVALID_CONTROL_REQUEST'|'INVALID_CLI_ARGUMENT'|'CONTROL_PROTOCOL_ERROR'='INVALID_CONTROL_REQUEST'):MoteMainRolloverDecision {
 const p=rpcRecord(value,['target','expectedRoleRevision','reference','policyRevision','policy','activity','evaluatedAt','queryOperationId','creationOperationId'],code)
 parseMotePreferencesTarget(p.target,code);const reference=parseMoteDefaultConversation(p.reference,code)
 for(const field of ['expectedRoleRevision','policyRevision','queryOperationId','creationOperationId'])if(typeof p[field]!=='string'||!String(p[field]).trim()||/[\0\r\n]/u.test(String(p[field])))throw new AgentMuxError('The original rollover identity is invalid.',code)
 const policy=parseMoteQuickDefaults({conversationRollover:p.policy},code).conversationRollover
 const a=rpcRecord(p.activity,['inputKey','run','sourceId','sequence','idleSince'],code),key=validateAgentPromptInputKey(a.inputKey),run=rpcRecord(a.run,['runId'],code)
 if(policy?.kind!=='idle'||key.kind!=='prompt'||key.agentSessionId!==reference.sessionId||key.expectedRun.runId!==run.runId||typeof a.sourceId!=='string'||!a.sourceId||!Number.isSafeInteger(a.sequence)||Number(a.sequence)<1||!Number.isSafeInteger(a.idleSince)||Number(a.idleSince)<0||!Number.isSafeInteger(p.evaluatedAt)||Number(p.evaluatedAt)<Number(a.idleSince))throw new AgentMuxError('The original rollover activity source is invalid.',code)
 return p as MoteMainRolloverDecision
}
export function parseMoteMainTransitionCause(value:unknown):MoteMainTransitionCause {
 const p=rpcRecord(value,['kind','operationId','decision'],'CONTROL_PROTOCOL_ERROR')
 if(typeof p.operationId!=='string'||!p.operationId||!['initial','manual-takeover','selection','clear','automatic'].includes(String(p.kind)))throw new AgentMuxError('The original Main transition cause is invalid.','CONTROL_PROTOCOL_ERROR')
 if(p.kind==='automatic')parseMoteMainRolloverDecision(p.decision,'CONTROL_PROTOCOL_ERROR')
 else if(p.decision!==undefined)throw new AgentMuxError('A manual transition cannot claim an automatic decision.','CONTROL_PROTOCOL_ERROR')
 return p as MoteMainTransitionCause
}
