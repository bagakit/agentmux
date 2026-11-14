// gemini top-level flag `--approval-mode <default|auto_edit|yolo|plan>`, verified against the installed
// binary's own `--help` choices list. `-y/--yolo` is an alias for `--approval-mode yolo`, so it is NOT
// declared as a second option — one control, no double-set. `-m/--model` takes a free string with no
// enum, so no model option is declared (a hand-written model list would go stale the moment the vendor
// changes its lineup). Choices ordered safe → danger.
export const GEMINI_LAUNCH_OPTIONS = [
  {
    id: 'approval-mode',
    label: 'Approval mode',
    description: 'When Gemini pauses for approval before using a tool.',
    choices: [
      { id: 'default', label: 'Default', description: 'Prompt for approval.', tier: 'safe', argv: ['--approval-mode', 'default'] },
      { id: 'plan', label: 'Plan', description: 'Read-only mode.', tier: 'safe', argv: ['--approval-mode', 'plan'] },
      { id: 'auto_edit', label: 'Auto edit', description: 'Auto-approve edit tools.', tier: 'caution', argv: ['--approval-mode', 'auto_edit'] },
      { id: 'yolo', label: 'YOLO', description: 'Auto-approve all tools.', tier: 'danger', argv: ['--approval-mode', 'yolo'] }
    ]
  }
] as const
