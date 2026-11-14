import { AgentMuxError } from './errors.js'
import { parseNodeLocateParams } from './node-locator.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
export const NODE_LOCATOR_CLI_COMMAND: AgentMuxCliCommand = {
  method: 'node.locate', usage: '--alias LABEL [--expected-runtime ID]',
  summary: 'Locate a published alias within confirmed configured Hosts; preserve original Runtime identity.',
  flags: { '--alias': 'data', '--expected-runtime': 'value' },
  details: 'Returns status, original publications, every confirmed hostIds carrier and unknown scope issues. Unique is scope-qualified, not global discovery. An original Runtime pin survives alias rename. Unconfirmed exits nonzero; inspect status before navigation. No Node, Agent, Run, permissions or configured route is created or changed.',
  parse: async args => {
    const input: Record<string, unknown> = {}, seen = new Set<string>()
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]!, value = args[i + 1]
      if (!['--alias', '--expected-runtime'].includes(flag) || seen.has(flag) || value === undefined) throw new AgentMuxError('Use --alias LABEL and optionally --expected-runtime ID exactly once.', 'INVALID_CLI_ARGUMENT')
      seen.add(flag); input[flag === '--alias' ? 'alias' : 'expectedRuntimeId'] = value
    }
    return parseNodeLocateParams(input)
  }
}
