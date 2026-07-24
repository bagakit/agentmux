import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'

describe('built-in agent providers', () => {
  const providers = new AgentProviderRegistry()

  it.each(['codex', 'claude', 'pi'] as const)('delivers %s prompts as positional argv data', (id) => {
    const plan = providers.get(id).buildLaunch({
      workspacePath: '/tmp/work',
      prompt: 'fix "quoted"\ntext',
      args: ['--model', 'demo'],
      env: {}
    })
    expect(plan).toEqual({
      command: id,
      args: ['--model', 'demo', 'fix "quoted"\ntext'],
      env: {}
    })
  })

  it('uses Hermes native query mode and keeps the TUI alive', () => {
    const plan = providers.get('hermes').buildLaunch({
      workspacePath: '/tmp/work',
      prompt: 'inspect this repo',
      args: ['--yolo'],
      env: { DEMO: '1' }
    })
    expect(plan).toEqual({
      command: 'hermes',
      args: ['chat', '--query', 'inspect this repo', '--yolo', '--tui'],
      env: { DEMO: '1' }
    })
  })

  it('keeps shell-looking prompts as one argv value', () => {
    const plan = providers.get('codex').buildLaunch({
      workspacePath: '/tmp/work',
      prompt: '$(touch /tmp/not-executed)',
      args: [],
      env: {},
      commandOverride: '/opt/tools/codex'
    })
    expect(plan.command).toBe('/opt/tools/codex')
    expect(plan.args).toEqual(['$(touch /tmp/not-executed)'])
  })
})
