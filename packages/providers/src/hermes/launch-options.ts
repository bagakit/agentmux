// hermes top-level boolean `--yolo` ("Bypass all dangerous command approval prompts"), verified against
// the installed binary's own `--help`. A boolean switch, so it is expressed as two choices whose argv is
// the honest thing each does: the conservative default contributes NO argv (hermes keeps prompting) and
// the yolo choice contributes the flag. `-m/--model` is a free string — no enum, so no model option.
export const HERMES_LAUNCH_OPTIONS = [
  {
    id: 'yolo',
    label: 'Approvals',
    description: 'Whether Hermes bypasses its dangerous-command approval prompts.',
    choices: [
      { id: 'default', label: 'Ask', description: 'Prompt before dangerous commands.', tier: 'safe', argv: [] },
      { id: 'yolo', label: 'YOLO', description: 'Bypass all dangerous-command approval prompts.', tier: 'danger', argv: ['--yolo'] }
    ]
  }
] as const
