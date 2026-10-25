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
      summary: ({ list: 'List durable arrangements.', inspect: 'Inspect an arrangement or original operation.', create: 'Save a calendar, one-shot or repeating message.', pause: 'Pause an arrangement.', resume: 'Resume its original due occurrence.', cancel: 'Cancel future occurrences without stopping the Agent.' })[action],
      details: `For list, omit data to read all saved arrangements, use {target:{hostId,agentSessionId,providerId,workspacePath}} for one exact discussion, or use {scope:{hostId,workspacePath}} for all discussions at that exact execution directory. target and scope are mutually exclusive; scope matches Host and full directory exactly, never a directory prefix. List includes calendar rules, afterMs countdowns and everyMs repeating messages without changing their original target or control authorization. Executes only while the connected desktop Host is running. Calendar policies are explicit: gap skip, fold earlier/later, month-end clamp, overdue latest. Mutations require operationId and expectedRevision; create requires exact target, prompt, operationId and exactly one calendar, positive safe-integer afterMs or whole-minute everyMs (milliseconds; minimum 60000). Relative timing does not accept checkIn. Repeating messages preserve the first due time as their cadence anchor and collapse missed occurrences to the latest. Its first save freezes nextCheckAt as an absolute deadline; original-operation retry and pause/resume do not restart the duration. Pause stops delivery, not the clock; overdue resume retains the original due occurrence. A confirmed one-shot delivery ends the arrangement. The Host checks once per second; this is not a real-time alarm, and App exit/sleep is outside its online guarantee. Example --data JSON: {"target":{"hostId":"local","agentSessionId":"EXACT_SESSION","providerId":"EXACT_PROVIDER","workspacePath":"EXACT_WORKSPACE"},"afterMs":90000,"prompt":"Continue the authorized original task.","operationId":"ORIGINAL_OPERATION"}. Use 300000 for five minutes. Optional checkIn is explicit user/device opt-in: {silenceMs,minIntervalMs,dailyBudget,quiet:{start,end}} in the calendar time zone; omitted is off. Intervals accept 5 minutes to 30 days, dailyBudget 1 to 3, and distinct HH:mm quiet endpoints. The desktop defaults to 18h silence, 20h between attempts, budget 1 and ${DEFAULT_AGENT_SCHEDULE_CHECK_IN.quiet.start}–${DEFAULT_AGENT_SCHEDULE_CHECK_IN.quiet.end} quiet. It requires current confirmed conversation context and a genuine human reply before another question. Unknown delivery retains the original operation.`,
      flags: { '--data': 'data' },
      parse: async (args: readonly string[]) => {
        if (args.length === 0 && action === 'list') return {}
        if (args.length !== 2 || args[0] !== '--data') throw new AgentMuxError('Schedule commands accept exactly --data <FILE|->.', 'INVALID_CLI_ARGUMENT')
        return parseScheduleRpcParams(method, await readControlJsonInput(args[1]!, 'Schedule')) as unknown as Record<string, unknown>
      } } satisfies AgentMuxCliCommand]
  })
)
