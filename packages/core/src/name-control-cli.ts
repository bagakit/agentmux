import { expandCliOptionAssignments } from './cli-option-assignments.js'
import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'
import { NAME_CONTROL_METHODS, parseNameControlParams, type NameControlMethod } from './name-control.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
export const NAME_CONTROL_CLI_COMMANDS: readonly AgentMuxCliCommand[] = (Object.keys(NAME_CONTROL_METHODS) as NameControlMethod[]).map(method => ({
  method, usage: '--input FILE|-', flags: { '--input': 'data' },
  summary: method.startsWith('space.member.') ? 'Read or explicitly change the original Source member Agent or Tab name.' : 'Read or explicitly change one exact local Session display name at its original Core.',
  details: 'Source input contains target:{reference:{runtimeId,spaceId},regionId,runtimeId,agentSessionId,expectedAdmission:{kind:creation|association,operationId}} and object:agent|tab. Local inspect contains runtimeId,agentSessionId and optional operationId, independent of Session/creation/Run observation. Local change also requires createOperationId; change contains change:{kind:rename,operationId,name,expectedNameRevision,source:manual|launch|derived} or {kind:confirm,operationId}. No Run is required. Current names and observed original records do not acknowledge an earlier write. Explicit confirm only flushes the original name document, never replays a rename. Reach Agent naming uses its separately authenticated original Coordinator and local owner; Source association grants no reverse carrier. Existing agent rename retains receiving-client override semantics. Native Provider name synchronization is separate and is not claimed by display-name saves.',
  parse: async args => {
    args = expandCliOptionAssignments(args)
    if (args.length !== 2 || args[0] !== '--input' || !args[1]) throw new AgentMuxError('Use the original name --input FILE|- exactly once; read --help.', 'INVALID_CLI_ARGUMENT')
    return parseNameControlParams(method, await readControlJsonInput(args[1], 'Original qualified name'))
  }
}))
