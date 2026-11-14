// grok top-level flag `--permission-mode <default|acceptEdits|auto|dontAsk|bypassPermissions|plan>`,
// verified against the installed binary's own `--help` possible-values list. This is the SPAWN-time
// analogue of grok's live posture control (`/always-approve [on|off]`, declared in agent-provider.ts):
// the launch option sets the initial posture in argv, the posture control flips it in-band mid-session —
// the two are complementary, which is why grok should carry both. `-m/--model` is a free string — no enum,
// so no model option. Choices ordered safe → danger.
export const GROK_LAUNCH_OPTIONS = [
  {
    id: 'permission-mode',
    label: 'Permission mode',
    description: 'How Grok handles tool-permission prompts for this session.',
    choices: [
      { id: 'default', label: 'Default', description: 'Ask for approval.', tier: 'safe', argv: ['--permission-mode', 'default'] },
      { id: 'plan', label: 'Plan', description: 'Plan first, no edits.', tier: 'safe', argv: ['--permission-mode', 'plan'] },
      { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-accept file edits.', tier: 'caution', argv: ['--permission-mode', 'acceptEdits'] },
      { id: 'auto', label: 'Auto', tier: 'caution', argv: ['--permission-mode', 'auto'] },
      { id: 'dontAsk', label: "Don't ask", tier: 'caution', argv: ['--permission-mode', 'dontAsk'] },
      { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Skip all permission checks.', tier: 'danger', argv: ['--permission-mode', 'bypassPermissions'] }
    ]
  }
] as const
