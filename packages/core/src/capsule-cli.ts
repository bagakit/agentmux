import { CAPSULE_METHODS, parseCapsuleRpcParams, type CapsuleMethod } from './capsule.js'
import { readControlJsonInput } from './cli-json-input.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { CAPSULE_RUNTIME_METHODS, parseCapsuleRuntimeParams, type CapsuleRuntimeMethod } from './capsule-runtime.js'

const descriptions = {
  'capsule.asset.read': 'Read one bounded byte span of an exact Capsule asset from its original service instance.',
  'capsule.ls': 'List durable local pages and their actual content/service observations.',
  'capsule.inspect': 'Inspect one exact original Capsule without opening a Browser.',
  'capsule.resolve': 'Read the original Capsule endpoint and service availability.',
  'capsule.create': 'Save a managed copy or register an exact external directory.',
  'capsule.update': 'Update one original page at its expected revision.',
  'capsule.remove': 'Remove one exact page; external source content is never deleted.',
  'capsule.operation.inspect': 'Read one retained operation without repeating it.',
  'capsule.config.inspect': 'Read the Capsule-owned creation defaults and new-content root.',
  'capsule.config.update': 'Save creation defaults without reinterpreting existing pages.',
  'capsule.open': 'Request presentation of one exact Capsule, retaining its original operation.',
  'capsule.interaction.request': 'Save a page-business question for the page’s original Agent target.',
  'capsule.interaction.ls': 'List original page-business questions without sending input.',
  'capsule.interaction.inspect': 'Read one exact page question and its saved answer state.',
  'capsule.interaction.draft': 'Save a draft at its expected revision without submitting it.',
  'capsule.interaction.reply': 'Submit an answer through its original trusted human-input owner.',
} satisfies Record<CapsuleMethod, string>

const inputs = {
  'capsule.asset.read': '{capsuleId,expectedRevision,expectedInstanceId,path,offset,length,assetStamp?,accept?,head?}',
  'capsule.ls': '{}',
  'capsule.inspect': '{capsuleId}',
  'capsule.resolve': '{capsuleId}',
  'capsule.create': '{operationId,sourcePath,title?,storageMode?:managed|path,mode?:isolated|injected,theme?:follow|none,entry?,routing?:file|spa,target?:{hostId,agentSessionId},source?}',
  'capsule.update': '{capsuleId,operationId,expectedRevision,changes:{title?,sourcePath?,mode?,theme?,entry?,routing?}}',
  'capsule.remove': '{capsuleId,operationId,expectedRevision,deleteContent?}',
  'capsule.operation.inspect': '{operationId}',
  'capsule.config.inspect': '{}',
  'capsule.config.update': '{operationId,expectedRevision,changes:{contentRoot?,defaultStorageMode?,defaultMode?,defaultTheme?}}',
  'capsule.open': '{capsuleId,operationId,placement?}',
  'capsule.interaction.request': '{capsuleId,operationId,question,draft?}',
  'capsule.interaction.ls': '{capsuleId}',
  'capsule.interaction.inspect': '{capsuleId,interactionId}',
  'capsule.interaction.draft': '{capsuleId,interactionId,operationId,expectedRevision,draft}',
  'capsule.interaction.reply': '{capsuleId,interactionId,operationId,expectedRevision,answer}',
} satisfies Record<CapsuleMethod, string>

// Shared by every Capsule action. Each action adds only what its own caller needs.
const COMMON = 'IDs are exact original identities from Capsule discovery. After an unknown result keep the original operationId and read capsule operation inspect; never replay or create a replacement. Read amux capsule --skill before acting.'

const notes: Partial<Record<CapsuleMethod, string>> = {
  'capsule.create': 'target is the recipient of page questions, fixed at creation; omitted means you, the authenticated calling Agent. Managed pages keep a copy; path pages follow their external directory, and relative entry paths stay inside it. Source metadata is a declaration, never authorship or permission.',
  'capsule.update': 'Creation defaults and contentRoot affect only new pages; target cannot change.',
  'capsule.config.update': 'New defaults and contentRoot affect only new pages.',
  'capsule.open': 'A returned Browser, Tab and Region confirm presentation only, not Agent delivery.',
  'capsule.interaction.request': 'Ask before you share the page link. The confirmed answer arrives as your next input in an <amux:capsule-answer> envelope.',
  'capsule.interaction.inspect': 'Saving an answer, submitting it and the Agent adopting it are separate results.',
  'capsule.interaction.reply': 'Only the trusted App sends a person\'s confirmed answer. Agents and pages are refused.',
}

/** The package owns methods and strict payloads; the CLI only selects a JSON carrier. */
export const AGENTMUX_CAPSULE_CLI_COMMANDS: readonly AgentMuxCliCommand[] = [...(Object.keys(CAPSULE_METHODS) as CapsuleMethod[]).map(method => {
  const optional = method === 'capsule.ls' || method === 'capsule.config.inspect'
  return { method, usage: optional ? '[--input <FILE|->]' : '--input <FILE|->',
    summary: descriptions[method], flags: { '--input': 'data' as const },
    details: `JSON input: ${inputs[method]}. ${notes[method] ? notes[method] + ' ' : ''}${COMMON}`,
    parse: async (args: string[]) => {
      if (!args.length && optional) return parseCapsuleRpcParams(method, {}) as unknown as Record<string, unknown>
      if (args.length !== 2 || args[0] !== '--input') throw new AgentMuxError('Capsule commands accept exactly --input <FILE|->.', 'INVALID_CLI_ARGUMENT')
      return parseCapsuleRpcParams(method, await readControlJsonInput(args[1]!, 'Capsule')) as unknown as Record<string, unknown>
    } }
}), ...(Object.keys(CAPSULE_RUNTIME_METHODS) as CapsuleRuntimeMethod[]).map(method => ({
  method, usage: method.endsWith('.inspect') ? '[--input <FILE|->]' : '--input <FILE|->',
  summary: method.endsWith('.inspect') ? 'Inspect the execution Host’s original Capsule service Run and intent.' :
    method.endsWith('.start') ? 'Persist running intent and start or reconnect the fixed Capsule service Run.' :
      'Persist stopped intent and stop only the exact observed Capsule service Run.',
  flags: { '--input': 'data' as const },
  details: `JSON input: ${method.endsWith('.inspect') ? '{operationId?}' : method.endsWith('.start') ? '{operationId,expectedRevision,recovery?:{revision,managementOperationId,createOperationId,launchDigest,runtime:{runtimeId,instanceId,buildIdentity,protocolVersion}}}' : '{operationId,expectedRevision,expectedRun:{runId}|null}'}. Core manages the fixed independent runtime through ctxmux. App/Core exit only detaches management. An explicit Stop survives restart and ordinary page reads never undo it. After an unknown effect retain the original operation and Run; runtime inspect with its operationId reads the original command without resending. A confirmed not_applied result allows only a new explicit command with a fresh ID and current revision. For an unresolved creation, copy the exact recoveryTarget from inspect (runtime:null means original Native owner evidence is missing and must be established from original authoritative records) into an explicit new Start's recovery field. This records an exact Native retirement intent before its first invocation; only a durable retired receipt permits a new launch key in the same namespace. A matching retained Run reconnects without Stop. After an unknown recovery result, inspect its original operation and repeat only that identical recovery command to observe and explicitly continue the same retry-safe Native retirement intent; the original Start is never replayed. not_retired is no historical nonapplication receipt. Paths and loopback endpoints belong to the execution Host. Remote access grants no public bind, tunnel or Human confirmation.`,
  parse: async (args: string[]) => {
    if (!args.length && method.endsWith('.inspect')) return parseCapsuleRuntimeParams(method, {}) as unknown as Record<string, unknown>
    if (args.length !== 2 || args[0] !== '--input') throw new AgentMuxError('Capsule runtime commands accept exactly --input <FILE|->.', 'INVALID_CLI_ARGUMENT')
    return parseCapsuleRuntimeParams(method, await readControlJsonInput(args[1]!, 'Capsule runtime')) as unknown as Record<string, unknown>
  }
}))]
