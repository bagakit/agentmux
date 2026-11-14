// claude top-level flags, all verified via `claude --help`:
//   `--model <alias>` ENUMERATES the aliases `fable` / `opus` / `sonnet` (it also accepts full model
//     names, but only the enumerated aliases are declared — a hand-written full-name list would go stale
//     the moment Anthropic ships a new model, exactly why the free-string `-m` on other providers gets no
//     option at all).
//   `--effort <level>` ENUMERATES `low | medium | high | xhigh | max`.
//   `--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`.
// model and effort choices carry NO tier on purpose: RiskTier grades how dangerous an approval/sandbox
// posture is, and picking a model or a reasoning depth neither widens nor narrows any permission — a tier
// there would paint a false risk mark on the roster row and the launcher summary. permission-mode is the
// only one that moves the permission posture, so it is the only one tiered. All three compose in
// declaration order and fold in cleanly ahead of the positional prompt.
export const CLAUDE_LAUNCH_OPTIONS = [
  {
    id: 'model',
    label: 'Model',
    description: 'Which Claude model this session runs on.',
    choices: [
      { id: 'fable', label: 'Fable', argv: ['--model', 'fable'] },
      { id: 'opus', label: 'Opus', argv: ['--model', 'opus'] },
      { id: 'sonnet', label: 'Sonnet', argv: ['--model', 'sonnet'] }
    ]
  },
  {
    id: 'effort',
    label: 'Effort',
    description: 'Reasoning effort for this launch. Model support and configured limits can cap the level.',
    choices: [
      { id: 'low', label: 'Low', description: 'Less reasoning for straightforward work; uses fewer resources.', argv: ['--effort', 'low'] },
      { id: 'medium', label: 'Medium', description: 'A moderate reasoning budget between Low and High.', argv: ['--effort', 'medium'] },
      { id: 'high', label: 'High', description: 'Deeper reasoning for complex work; uses more resources.', argv: ['--effort', 'high'] },
      { id: 'xhigh', label: 'Extra high', description: 'More reasoning than High for demanding work.', argv: ['--effort', 'xhigh'] },
      { id: 'max', label: 'Max', description: 'Highest reasoning effort; can use substantially more tokens.', argv: ['--effort', 'max'] }
    ]
  },
  {
    id: 'permission-mode',
    argumentAliases: [{ flag: '--dangerously-skip-permissions', arity: 0 }],
    label: 'Permission mode',
    description: 'How Claude handles tool-permission prompts for this session.',
    choices: [
      { id: 'manual', label: 'Manual', description: 'Ask for each action.', tier: 'safe', argv: ['--permission-mode', 'manual'] },
      { id: 'plan', label: 'Plan', description: 'Plan first, no edits.', tier: 'safe', argv: ['--permission-mode', 'plan'] },
      { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-accept file edits.', tier: 'caution', argv: ['--permission-mode', 'acceptEdits'] },
      { id: 'auto', label: 'Auto', tier: 'caution', argv: ['--permission-mode', 'auto'] },
      { id: 'dontAsk', label: "Don't ask", tier: 'caution', argv: ['--permission-mode', 'dontAsk'] },
      { id: 'bypassPermissions', unrestricted: true, label: 'Bypass permissions', description: 'Skip all permission checks.', tier: 'danger', argv: ['--permission-mode', 'bypassPermissions'] }
    ]
  }
] as const
