// antigravity (agy) top-level boolean `--sandbox` ("Run in a sandbox with terminal restrictions enabled"),
// verified against the installed binary's own `--help`. A boolean switch expressed as two choices: the
// default contributes NO argv (agy's normal, unsandboxed mode) and the sandboxed choice contributes the
// flag. The flag ADDS containment, so enabling it is the 'safe' tier; the unsandboxed default runs terminal
// commands without restriction and honestly carries 'caution'. `--model` is a free string — no enum.
export const ANTIGRAVITY_LAUNCH_OPTIONS = [
  {
    id: 'interaction', label: 'Interaction', description: 'Choose the terminal or a structured ACP session.', choices: [
      { id: 'terminal', label: 'Terminal', argv: [] },
      { id: 'acp', label: 'ACP', description: 'Open a structured session.', argv: [] }
    ]
  },
  {
    id: 'sandbox',
    argumentAliases: [{ flag: '-s', arity: 1 }, { flag: '--yolo', arity: 0 }, { flag: '--approve-for-me', arity: 0 }, { flag: '--dangerously-bypass-approvals-and-sandbox', arity: 0 }],
    label: 'Sandbox',
    description: 'Whether Antigravity runs with terminal restrictions.',
    choices: [
      { id: 'default', label: 'Off', description: 'No sandbox — terminal commands run unrestricted.', tier: 'caution', argv: [] },
      { id: 'sandboxed', label: 'Sandboxed', description: 'Run with terminal restrictions enabled.', tier: 'safe', argv: ['--sandbox'] }
    ]
  }
] as const
