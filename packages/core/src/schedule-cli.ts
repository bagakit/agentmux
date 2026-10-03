import { readControlJsonInput } from './cli-json-input.js'
import { parseScheduleRpcParams, type ScheduleMethod } from './public-rpc-schedules.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

/** JSON stdin preserves exact target, civil policies, original message and business operation ID. */
export const AGENTMUX_SCHEDULE_CLI_COMMANDS: Readonly<Record<string, AgentMuxCliCommand>> = Object.fromEntries(
  (['list','inspect','create','pause','resume','cancel'] as const).map(action => {
    const method = `schedule.${action}` as ScheduleMethod
    return [`schedule ${action}`, { method, usage: `schedule ${action} [--data <FILE|->]`,
      summary: ({ list: 'List durable arrangements.', inspect: 'Inspect an arrangement or original operation.', create: 'Save a civil-time future message.', pause: 'Pause an arrangement.', resume: 'Resume its original due occurrence.', cancel: 'Cancel future occurrences without stopping the Agent.' })[action],
      details: 'Executes only while the connected desktop Host is running. Calendar policies are explicit: gap skip, fold earlier/later, month-end clamp, overdue latest. Mutations require operationId and expectedRevision; create requires exact target, calendar, prompt and operationId.',
      flags: { '--data': 'data' },
      parse: async (args: readonly string[]) => {
        if (args.length === 0 && action === 'list') return {}
        if (args.length !== 2 || args[0] !== '--data') throw new AgentMuxError('Schedule commands accept exactly --data <FILE|->.', 'INVALID_CLI_ARGUMENT')
        return parseScheduleRpcParams(method, await readControlJsonInput(args[1]!, 'Schedule')) as unknown as Record<string, unknown>
      } } satisfies AgentMuxCliCommand]
  })
)
