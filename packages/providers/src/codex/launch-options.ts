// codex top-level (interactive) flags. `-s/--sandbox <read-only|workspace-write|danger-full-access>` and
// `-a/--ask-for-approval <on-request|never>` verified via `codex --help`. Two options that compose.
export const CODEX_LAUNCH_OPTIONS = [
  {
    id: 'sandbox',
    argumentAliases: [{ flag: '-s', arity: 1 }, { flag: '--yolo', arity: 0 }, { flag: '--approve-for-me', arity: 0 }, { flag: '--dangerously-bypass-approvals-and-sandbox', arity: 0 }],
    label: 'Sandbox',
    description: 'How much of the machine Codex may touch when it runs commands.',
    choices: [
      { id: 'read-only', label: 'Read only', tier: 'safe', argv: ['--sandbox', 'read-only'] },
      {
        id: 'workspace-write',
        label: 'Workspace write',
        description: 'Writes limited to the workspace.',
        tier: 'caution',
        argv: ['--sandbox', 'workspace-write']
      },
      {
        id: 'danger-full-access', unrestricted: true,
        label: 'Full access',
        description: 'No sandbox — full machine access.',
        tier: 'danger',
        argv: ['--sandbox', 'danger-full-access']
      }
    ]
  },
  {
    id: 'approval',
    argumentAliases: [{ flag: '-a', arity: 1 }],
    label: 'Approval policy',
    description: 'When Codex pauses for human approval before running a command.',
    choices: [
      {
        id: 'on-request',
        label: 'On request',
        description: 'The model decides when to ask.',
        tier: 'caution',
        argv: ['--ask-for-approval', 'on-request']
      },
      {
        id: 'never', unrestricted: true,
        label: 'Never',
        description: 'Never pauses for approval.',
        tier: 'danger',
        argv: ['--ask-for-approval', 'never']
      }
    ]
  }
] as const
