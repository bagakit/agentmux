/** Native passive observer protocol. `ask` keeps the original native permission flow. */
export const ANTIGRAVITY_PASSIVE_HOOK_RESPONSES: Readonly<Record<string, string>> = {
  PreToolUse: '{"decision":"ask"}\n',
  Stop: '{"decision":""}\n',
  StopFailure: '{"decision":""}\n'
}
