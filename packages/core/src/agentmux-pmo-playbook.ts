import { AGENTMUX_CLI_COMMANDS } from './agentmux-cli-commands.js'
import { goalRoleGuidance } from './goal-role-guidance.js'
import { guideText } from './guide-text.js'

/** Read-only system document; command syntax remains owned by the executable registry. */
export function agentMuxPmoPlaybook(): { readOnly: true; format: 'markdown'; document: string } {
  const commands = Object.fromEntries(AGENTMUX_CLI_COMMANDS.map(command => [
    'command:' + command.method,
    `amux ${command.method.replaceAll('.', ' ')}${command.usage ? ' ' + command.usage : ''}`
  ]))
  const commandFact = (key: `command:${string}`): string => {
    const syntax = commands[key]
    if (syntax === undefined) throw new Error('Unknown playbook command: ' + key)
    return syntax
  }
  return { readOnly: true, format: 'markdown', document: guideText('actions/mote-pmo', key =>
    key === 'goal-manager-context' ? goalRoleGuidance({ role: 'manager' }) : commandFact(key)) }
}
