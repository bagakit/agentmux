import { readControlJsonInput } from './cli-json-input.js'
import { parseScheduleRpcParams, type ScheduleMethod } from './public-rpc-schedules.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { DEFAULT_AGENT_SCHEDULE_CHECK_IN } from './agent-schedule.js'

/** JSON stdin preserves exact target, civil policies, original message and business operation ID. */
export const AGENTMUX_SCHEDULE_CLI_COMMANDS: Readonly<Record<string, AgentMuxCliCommand>> = Object.fromEntries(
  (['list','inspect','create','pause','resume','cancel'] as const).map(action => {
    const method = `schedule.${action}` as ScheduleMethod
    return [`schedule ${action}`, { method, usage: action === 'list' ? '[--data <FILE|->]' : '--data <FILE|->',
      summary: ({ list: 'List durable arrangements.', inspect: 'Inspect an arrangement or original operation.', create: 'Save a civil-time future message.', pause: 'Pause an arrangement.', resume: 'Resume its original due occurrence.', cancel: 'Cancel future occurrences without stopping the Agent.' })[action],
      details: `Executes only while the connected desktop Host is running. Calendar policies are explicit: gap skip, fold earlier/later, month-end clamp, overdue latest. Mutations require operationId and expectedRevision; create requires exact target, calendar, prompt and operationId. Optional checkIn is explicit user/device opt-in: {silenceMs,minIntervalMs,dailyBudget,quiet:{start,end}} in the calendar time zone; omitted is off. Intervals accept 5 minutes to 30 days, dailyBudget 1 to 3, and distinct HH:mm quiet endpoints. The desktop defaults to 18h silence, 20h between attempts, budget 1 and ${DEFAULT_AGENT_SCHEDULE_CHECK_IN.quiet.start}–${DEFAULT_AGENT_SCHEDULE_CHECK_IN.quiet.end} quiet. It requires current confirmed conversation context and a genuine human reply before another question. Unknown delivery retains the original operation.`,
      flags: { '--data': 'data' },
      parse: async (args: readonly string[]) => {
        if (args.length === 0 && action === 'list') return {}
        if (args.length !== 2 || args[0] !== '--data') throw new AgentMuxError('Schedule commands accept exactly --data <FILE|->.', 'INVALID_CLI_ARGUMENT')
        return parseScheduleRpcParams(method, await readControlJsonInput(args[1]!, 'Schedule')) as unknown as Record<string, unknown>
      } } satisfies AgentMuxCliCommand]
  })
)
