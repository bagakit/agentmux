import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'

describe('built-in agent providers', () => {
  const providers = new AgentProviderRegistry()

  it('publishes a complete catalog for every built-in Agent', () => {
    expect(providers.catalog().map((entry) => ({
      id: entry.id,
      executable: entry.executable,
      expectedProcess: entry.expectedProcess,
      promptDelivery: entry.promptDelivery,
      readySignal: entry.readySignal.kind,
      hook: entry.hookStrategy.kind,
      resume: entry.resumeStrategy.kind,
      acp: entry.acpStrategy.kind
    }))).toEqual([
      {
        id: 'codex', executable: 'codex', expectedProcess: 'codex',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'native', resume: 'provider-native', acp: 'none'
      },
      {
        id: 'claude', executable: 'claude', expectedProcess: 'claude',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'native', resume: 'provider-native', acp: 'none'
      },
      {
        id: 'traex', executable: 'traex', expectedProcess: 'traex',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'none', resume: 'none', acp: 'none'
      },
      {
        id: 'hermes', executable: 'hermes', expectedProcess: 'hermes',
        promptDelivery: 'hermes-query', readySignal: 'foreground-process',
        hook: 'native', resume: 'none', acp: 'none'
      },
      {
        id: 'pi', executable: 'pi', expectedProcess: 'pi',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'native', resume: 'provider-native', acp: 'none'
      }
    ])
  })

  it.each(['codex', 'claude', 'traex', 'pi'] as const)('delivers %s prompts as positional argv data', (id) => {
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

  it('probes the selected executable on the execution host', async () => {
    const probes: string[] = []
    await expect(providers.get('claude').probeCapabilities({
      async hasExecutable(executable) {
        probes.push(executable)
        return executable === '/opt/claude'
      }
    }, '/opt/claude')).resolves.toMatchObject({
      agentId: 'claude',
      executable: '/opt/claude',
      installed: true,
      capabilities: { hookEvents: true, providerResume: true, acp: false }
    })
    expect(probes).toEqual(['/opt/claude'])
  })

  it('builds provider-native resume argv only from a matching verified handle', () => {
    expect(providers.get('codex').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-1' },
      args: ['--model', 'demo'],
      env: {}
    })).toEqual({
      command: 'codex',
      args: ['resume', 'native-1', '--model', 'demo'],
      env: {}
    })
    expect(() => providers.get('pi').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'pi', sessionId: 'native-2' },
      args: [],
      env: {}
    })).toThrow('session file')
    expect(() => providers.get('hermes').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'hermes', sessionId: 'native-3' },
      args: [],
      env: {}
    })).toThrow('does not support')
  })
})
