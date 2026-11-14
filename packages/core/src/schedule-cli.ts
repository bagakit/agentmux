import { expandCliOptionAssignments } from './cli-option-assignments.js'
import { readControlJsonInput } from './cli-json-input.js'
import { parseScheduleRpcParams, type ScheduleMethod } from './public-rpc-schedules.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

/** JSON stdin preserves exact target, civil policies, original message and business operation ID. */
export const AGENTMUX_SCHEDULE_CLI_COMMANDS: Readonly<Record<string, AgentMuxCliCommand>> = Object.fromEntries(
  (['list','inspect','create','update','pause','resume','cancel'] as const).map(action => {
    const method = `schedule.${action}` as ScheduleMethod
    return [`schedule ${action}`, { method, usage: action === 'list' ? '[--data <FILE|->]' : '--data <FILE|->',
      summary: ({ list: 'List durable arrangements.', inspect: 'Inspect an arrangement or original operation.', create: 'Save a calendar, one-shot or repeating message.', update: 'Change the interval of the original repeating arrangement without replacing its claimed input.', pause: 'Pause an arrangement.', resume: 'Resume its original due occurrence.', cancel: 'Cancel future occurrences without stopping the Agent.' })[action],
      details: ({
        list: 'Input: {} or {target:{hostId,agentSessionId,providerId,workspacePath}} or {scope:{hostId,workspacePath}}. Example JSON: {"scope":{"hostId":"local","workspacePath":"/exact/workspace"}}',
        inspect: 'Input: exactly one {scheduleId} or {operationId}. Original-operation inspection is read-only and never redelivers. Example JSON: {"operationId":"ORIGINAL_OPERATION"}',
        create: 'Input: {target:{hostId,agentSessionId,providerId,workspacePath},prompt,operationId} and exactly one {afterMs}, {everyMs}, or {calendar}. Calendar common fields: {kind,timezone,time,policies:{gap:"skip",fold:"earlier"|"later",monthEnd:"clamp",overdue:"latest"}}. Choose kind once with date:YYYY-MM-DD; daily with no extra fields; weekly with weekday:1..7 (Monday..Sunday); monthly with day:1..31; yearly with month:1..12 and day:1..31. time is HH:mm and timezone is an IANA name. Calendar uses gap skip, explicit fold earlier/later, month-end clamp and overdue latest. afterMs is a positive safe integer; everyMs is whole-minute milliseconds, at least 60000. Only calendar supports explicit person/device opt-in checkIn:{silenceMs,minIntervalMs,dailyBudget,quiet:{start,end}}; both intervals are 5 minutes–30 days, dailyBudget is 1–3 and quiet endpoints are distinct HH:mm in the calendar timezone. Omission disables check-in; it requires confirmed conversation context and a genuine human reply before another question. Example JSON: {"target":{"hostId":"local","agentSessionId":"EXACT_SESSION","providerId":"EXACT_PROVIDER","workspacePath":"/exact/workspace"},"calendar":{"kind":"weekly","weekday":1,"timezone":"Etc/UTC","time":"09:00","policies":{"gap":"skip","fold":"earlier","monthEnd":"clamp","overdue":"latest"}},"prompt":"Continue the authorized original task.","operationId":"ORIGINAL_OPERATION"}',
        update: 'Input: {scheduleId,expectedRevision,operationId,everyMs}. expectedRevision is the current positive revision from list/inspect. Example JSON: {"scheduleId":"EXACT_SCHEDULE","expectedRevision":1,"operationId":"ORIGINAL_OPERATION","everyMs":300000}',
        pause: 'Input: {scheduleId,expectedRevision,operationId}; use the observed revision. Example JSON: {"scheduleId":"EXACT_SCHEDULE","expectedRevision":1,"operationId":"ORIGINAL_OPERATION"}',
        resume: 'Input: {scheduleId,expectedRevision,operationId}; use the observed revision. Example JSON: {"scheduleId":"EXACT_SCHEDULE","expectedRevision":1,"operationId":"ORIGINAL_OPERATION"}',
        cancel: 'Input: {scheduleId,expectedRevision,operationId}; use the observed revision. Example JSON: {"scheduleId":"EXACT_SCHEDULE","expectedRevision":1,"operationId":"ORIGINAL_OPERATION"}'
      })[action] + '\nThe returned schedule.loopId is the scheduleId selector; keep creationOperationId/lastMutation.operationId as separate operation identities. Mutations require the original operationId; edit/lifecycle operations also require the observed expectedRevision. Unknown delivery retains the original operation; inspect it without automatic replay. Runs only while the original connected desktop Host is online; App exit/sleep is outside this guarantee. The Host checks once per second, not as a real-time alarm. Relative timing freezes an absolute deadline at admission; original-operation retry and pause/resume keep that deadline. Pause stops delivery, not time. Repeating cadence collapses missed occurrences to the latest; update preserves the original deadline and claimed input. managedSource, when returned, identifies the original configuration owner and binding revision; Agent callers cannot establish standing Host maintenance source.',
      flags: { '--data': 'data' },
      parse: async (args: readonly string[]) => {
      args = expandCliOptionAssignments(args)
        if (args.length === 0 && action === 'list') return {}
        if (args.length !== 2 || args[0] !== '--data') throw new AgentMuxError('Schedule commands accept exactly --data <FILE|->.', 'INVALID_CLI_ARGUMENT')
        return parseScheduleRpcParams(method, await readControlJsonInput(args[1]!, 'Schedule')) as unknown as Record<string, unknown>
      } } satisfies AgentMuxCliCommand]
  })
)
