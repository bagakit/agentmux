import { describe, expect, it } from 'vitest'
import { composeAgentLaunchPrompt } from '../src/agent-launch-prompt.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'

describe('Agent launch prompt', () => {
  it('keeps the guide and original user request as two clear sections', () => {
    const prompt = 'Inspect the failing test.\nKeep the fix small.'

    expect(composeAgentLaunchPrompt(prompt, true)).toBe(`AgentMux runtime guide:
You are running inside AgentMux, where you can open a terminal, a browser, or another agent into a split beside your view — left, right, above, or below — and rearrange a tab's layout. When a request needs any of that, run "$AGENTMUX_CLI" --skill for the exact commands before acting.

User request:
${prompt}`)
  })

  it('makes the split affordance and where to confirm it discoverable, without copying CLI syntax', () => {
    const guide = composeAgentLaunchPrompt('do the work', true)
    // The gap this closes is discovery: the Agent must learn the affordance EXISTS — that it can open a
    // terminal/browser/agent into a directional split — and where to get the exact commands.
    expect(guide).toContain('terminal')
    expect(guide).toContain('browser')
    expect(guide).toContain('agent')
    expect(guide).toContain('split')
    for (const direction of ['left', 'right', 'above', 'below']) expect(guide).toContain(direction)
    expect(guide).toContain('"$AGENTMUX_CLI" --skill')
    // But the skill stays the single source of truth for the commands: the guide names no flag syntax.
    for (const flag of ['--left-of', '--right-of', '--above', '--below', 'open terminal', 'open agent']) {
      expect(guide).not.toContain(flag)
    }
  })

  it('gives an idle launch an explicit wait instruction', () => {
    expect(composeAgentLaunchPrompt(undefined, true)).toContain(
      'User request:\nNo request yet. Wait for the user.'
    )
    expect(composeAgentLaunchPrompt('   ', true)).toContain(
      'User request:\nNo request yet. Wait for the user.'
    )
  })

  it('leaves the launch prompt unchanged when injection is disabled', () => {
    expect(composeAgentLaunchPrompt('Open Claude on the right.', false)).toBe(
      'Open Claude on the right.'
    )
    expect(composeAgentLaunchPrompt(undefined, false)).toBe('')
  })
})

describe('launch guide reaches every Provider spawn', () => {
  // Reproduce the ONE injection path the client runs (client.ts createAgent): the composed prompt is fed
  // straight into provider.buildLaunch({ prompt }), and buildLaunch is what places the prompt into the argv
  // ctxmux spawns. Asserting the guide lands in that argv — for every built-in Provider, whatever its prompt
  // shape (positional, hermes --query, --prompt-interactive) — proves injection reaches the launch, not just
  // that a helper returns a string. It goes red the instant composeAgentLaunchPrompt stops prepending the
  // guide or buildLaunch stops carrying the prompt.
  const providers = new AgentProviderRegistry()
  const ids = providers.catalog().map((entry) => entry.id)
  const userRequest = 'open a browser on the right'

  it.each(ids)('carries the guide into the spawned argv for %s when injection is on', (id) => {
    const launchPrompt = composeAgentLaunchPrompt(userRequest, true)
    const argv = providers.get(id).buildLaunch({
      workspacePath: '/tmp/work',
      prompt: launchPrompt,
      args: [],
      env: {}
    }).args.join('\n')

    // The distinctive discoverability content must be present in what actually gets spawned.
    expect(argv).toContain('AgentMux runtime guide:')
    expect(argv).toContain('into a split')
    expect(argv).toContain('"$AGENTMUX_CLI" --skill')
    // The user's real request survives alongside the guide.
    expect(argv).toContain(userRequest)
  })

  it.each(ids)('spawns the raw prompt with no guide for %s when injection is off', (id) => {
    const launchPrompt = composeAgentLaunchPrompt(userRequest, false)
    const argv = providers.get(id).buildLaunch({
      workspacePath: '/tmp/work',
      prompt: launchPrompt,
      args: [],
      env: {}
    }).args.join('\n')

    expect(argv).not.toContain('AgentMux runtime guide:')
    expect(argv).not.toContain('into a split')
    expect(argv).toContain(userRequest)
  })
})
