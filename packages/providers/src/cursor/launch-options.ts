// cursor-agent top-level flags, verified against the installed binary's own `--help`:
//   `--mode <plan|ask>` — an explicit choices list (`plan`: read-only planning; `ask`: read-only Q&A).
//     There is no `--mode full`; full read/edit/run is the no-flag default, so the 'default' choice
//     contributes NO argv.
//   `--sandbox <enabled|disabled>` — an explicit choices list.
//   `-f/--force` — a boolean ("Force allow commands unless explicitly denied"); the ask default
//     contributes no argv. `--yolo` is a documented alias for `--force`, so it is NOT a second option.
// Three options that compose. `--model` is a free string — no enum, so no model option.
export const CURSOR_LAUNCH_OPTIONS = [
  {
    id: 'mode',
    label: 'Execution mode',
    description: 'How much Cursor may change while it works.',
    choices: [
      { id: 'default', label: 'Full', description: 'Read, edit, and run.', tier: 'caution', argv: [] },
      { id: 'plan', label: 'Plan', description: 'Analyze and propose, no edits.', tier: 'safe', argv: ['--mode', 'plan'] },
      { id: 'ask', label: 'Ask', description: 'Q&A only, read-only.', tier: 'safe', argv: ['--mode', 'ask'] }
    ]
  },
  {
    id: 'sandbox',
    argumentAliases: [{ flag: '-s', arity: 1 }, { flag: '--yolo', arity: 0 }, { flag: '--approve-for-me', arity: 0 }, { flag: '--dangerously-bypass-approvals-and-sandbox', arity: 0 }],
    label: 'Sandbox',
    description: 'Whether Cursor runs commands inside its sandbox.',
    choices: [
      { id: 'enabled', label: 'Sandboxed', description: 'Commands run sandboxed.', tier: 'safe', argv: ['--sandbox', 'enabled'] },
      { id: 'disabled', label: 'Unsandboxed', description: 'Commands run without the sandbox.', tier: 'danger', argv: ['--sandbox', 'disabled'] }
    ]
  },
  {
    id: 'approvals',
    label: 'Approvals',
    description: 'Whether Cursor asks before running a command.',
    choices: [
      { id: 'default', label: 'Ask', description: 'Prompt before running commands.', tier: 'safe', argv: [] },
      { id: 'force', label: 'Run everything', description: 'Allow every command unless explicitly denied.', tier: 'danger', argv: ['--force'] }
    ]
  }
] as const
