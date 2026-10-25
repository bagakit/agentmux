import { describe, expect, it } from 'vitest'
import { withUnrestrictedLaunchArgs } from '../src/providers/launch-options.js'
import { withUnrestrictedLaunchOptionArgs } from '../src/agent-launch-option.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'

describe('Provider-declared unrestricted launch posture', () => {
  it('uses the same declared choices through the real Provider launch consumer', () => {
    const providers = new AgentProviderRegistry()
    for (const [id, selections, args] of [
      ['codex', { sandbox: 'danger-full-access', approval: 'never' }, ['--model', 'literal model', '-s', 'read-only', '-a=on-request', '--approve-for-me']],
      ['claude', { 'permission-mode': 'bypassPermissions' }, ['--model', 'opus', '--permission-mode=manual', '--dangerously-skip-permissions']]
    ] as const) {
      const provider = providers.get(id)
      const selected = withUnrestrictedLaunchArgs(id, args)!
      const expected = ['--model', id === 'codex' ? 'literal model' : 'opus', ...provider.resolveLaunchArgv(selections)]
      expect(selected).toEqual(expected)
      const launch = provider.buildLaunch({ workspacePath: '.', prompt: 'inspect', args: selected, env: {} })
      expect(launch.args).toEqual(expect.arrayContaining(expected))
      expect(launch.args).not.toContain('--approve-for-me')
      expect(launch.args).not.toContain('--dangerously-skip-permissions')
    }
  })

  it('requires explicit capability and preserves args outside the owned option or after the delimiter', () => {
    expect(withUnrestrictedLaunchArgs('unknown-provider', [])).toBeNull()
    expect(withUnrestrictedLaunchArgs('gemini', [])).toBeNull()
    const marked = [{ id: 'posture', label: 'Posture', choices: [
      { id: 'limited', label: 'Limited', argv: ['--posture', 'limited'] },
      { id: 'open', label: 'Open', unrestricted: true as const, argv: ['--posture', 'open'] }
    ] }]
    expect(withUnrestrictedLaunchOptionArgs(marked, ['--model', 'kept', '--posture=limited', '--', '--posture', 'literal']))
      .toEqual(['--model', 'kept', '--posture', 'open', '--', '--posture', 'literal'])
    expect(withUnrestrictedLaunchOptionArgs([{ id: 'danger', label: 'YOLO', choices: [{ id: 'x', label: 'Unrestricted', tier: 'danger', argv: ['--danger'] }] }], []))
      .toBeNull()
    expect(withUnrestrictedLaunchArgs('claude', ['--foreign-native-flag', '--sandbox', 'keep']))
      .toEqual(['--foreign-native-flag', '--sandbox', 'keep', '--permission-mode', 'bypassPermissions'])
    expect(withUnrestrictedLaunchArgs('codex', ['--sandbox', '--model', 'keep']))
      .toEqual(['--model', 'keep', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never'])
  })
})
