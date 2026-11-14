// traex top-level flags, verified against the installed binary's own `--help`:
//   `-s/--sandbox <read-only|workspace-write|danger-full-access>` — an explicit possible-values list.
//   `--permission-mode <default|bypass_permissions|auto>` — the FULL enum, confirmed by reading the
//     complete `--help` output. The batch table flagged this as truncated because each value carries a
//     multi-line description; the `auto` value sat below that fold. Two options that compose.
// `-m/--model` is a free string — no enum, so no model option. Choices ordered safe → danger.
export const TRAEX_LAUNCH_OPTIONS = [
  {
    id: 'sandbox',
    argumentAliases: [{ flag: '-s', arity: 1 }, { flag: '--yolo', arity: 0 }, { flag: '--approve-for-me', arity: 0 }, { flag: '--dangerously-bypass-approvals-and-sandbox', arity: 0 }],
    label: 'Sandbox',
    description: 'How much of the machine TraeX may touch when it runs commands.',
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
        id: 'danger-full-access',
        label: 'Full access',
        description: 'No sandbox — full machine access.',
        tier: 'danger',
        argv: ['--sandbox', 'danger-full-access']
      }
    ]
  },
  {
    id: 'permission-mode',
    label: 'Permission mode',
    description: 'How TraeX handles tool-permission prompts for this session.',
    choices: [
      {
        id: 'default',
        label: 'Default',
        description: 'Edit the workspace and run commands; the network or other files need approval.',
        tier: 'safe',
        argv: ['--permission-mode', 'default']
      },
      {
        id: 'auto',
        label: 'Auto',
        description: 'Workspace-write, with on-request approvals routed to an auto-reviewer.',
        tier: 'caution',
        argv: ['--permission-mode', 'auto']
      },
      {
        id: 'bypass_permissions',
        label: 'Bypass permissions',
        description: 'Edit files outside the workspace and access the internet without approval.',
        tier: 'danger',
        argv: ['--permission-mode', 'bypass_permissions']
      }
    ]
  }
] as const
