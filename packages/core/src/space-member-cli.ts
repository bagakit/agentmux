import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'
import { parseSpaceMemberParams } from './space-member-codec.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
export const SPACE_MEMBER_CLI_COMMANDS: readonly AgentMuxCliCommand[] = (['space.member.call','space.member.watch'] as const).map(method => ({
  method, usage: '--input FILE|-', flags: { '--input': 'data' },
  summary: method === 'space.member.call' ? 'Operate one original Space member through its exact current Run and finite Core SDK surface.' : 'Observe one original Space member’s full Session or Terminal through its own scoped reader.',
  details: 'Input is {target:{reference:{runtimeId,spaceId},regionId,runtimeId,agentSessionId,expectedRun:{runId}},call:{method,params}}. The selected source Core verifies its durable member/admission and frozen route; the execution Core independently checks the current viewer, Run and finite method. Inner fields are the existing runtime.owner.identity/bootstrap/invoke/release-consumer or runtime.events/attachment-watch/replay-watch protocol. No inventory, create, lifecycle recovery, human approval, arbitrary forwarding or implicit route is granted. Retain a Composer submission’s original operation and inspect its receipt. Raw write/paste has no caller business operation ID; an unknown raw acknowledgement is not resent or presented as an inspectable operation. Cancelling a reader does not stop the Agent.',
  parse: async args => {
    if (args.length !== 2 || args[0] !== '--input' || !args[1]) throw new AgentMuxError('Use the exact member --input FILE|- once; see --help.', 'INVALID_CLI_ARGUMENT')
    return parseSpaceMemberParams(method, await readControlJsonInput(args[1], 'Original Space member call'))
  }
}))
