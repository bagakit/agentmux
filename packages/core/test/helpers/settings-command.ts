import { parseAgentMuxCliInvocation } from '../../src/agentmux-cli-commands.js'

/** Exercise the same registered method selection and parameter parser as the executable CLI. */
export async function settingsCliCommand(args: readonly string[]) {
  const { command, params } = await parseAgentMuxCliInvocation(['settings', ...args])
  return { method: command.method, params }
}
