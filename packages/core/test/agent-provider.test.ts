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
      permission: entry.capabilities.permission,
      resume: entry.resumeStrategy.kind,
      acp: entry.acpStrategy.kind,
      replyCorrelation: entry.capabilities.replyCorrelation
    }))).toEqual([
      {
        id: 'codex', executable: 'codex', expectedProcess: 'codex',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'native', permission: 'observe', resume: 'provider-native', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'claude', executable: 'claude', expectedProcess: 'claude',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'native', permission: 'observe', resume: 'provider-native', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'traex', executable: 'traex', expectedProcess: 'traex',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'none', permission: 'none', resume: 'none', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'hermes', executable: 'hermes', expectedProcess: 'hermes',
        promptDelivery: 'hermes-query', readySignal: 'foreground-process',
        hook: 'native', permission: 'observe', resume: 'none', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'pi', executable: 'pi', expectedProcess: 'pi',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'native', permission: 'observe', resume: 'provider-native', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'grok', executable: 'grok', expectedProcess: 'grok',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'none', permission: 'none', resume: 'none', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'gemini', executable: 'gemini', expectedProcess: 'gemini',
        promptDelivery: 'flag-prompt-interactive', readySignal: 'foreground-process',
        hook: 'none', permission: 'none', resume: 'none', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'antigravity', executable: 'agy', expectedProcess: 'agy',
        promptDelivery: 'flag-prompt-interactive', readySignal: 'foreground-process',
        hook: 'none', permission: 'none', resume: 'none', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'cursor', executable: 'cursor-agent', expectedProcess: 'cursor-agent',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'none', permission: 'none', resume: 'none', acp: 'none',
        replyCorrelation: 'none'
      }
    ])
  })

  it('publishes each Provider timeline capability through the catalog', () => {
    const catalog = new Map(providers.catalog().map((provider) => [provider.id, provider]))

    expect(catalog.get('codex')?.capabilities.timeline).toBe('complete-events')
    expect(catalog.get('traex')?.capabilities.timeline).toBe('unavailable')
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

  it('launches Grok with the argv separator that guards flag-looking prompts', () => {
    expect(providers.get('grok').buildLaunch({
      workspacePath: '/tmp/work', prompt: '--version', args: ['--model', 'demo'], env: {}
    })).toEqual({ command: 'grok', args: ['--model', 'demo', '--', '--version'], env: {} })
    // No prompt → no trailing separator.
    expect(providers.get('grok').buildLaunch({
      workspacePath: '/tmp/work', prompt: '', args: ['--model', 'demo'], env: {}
    })).toEqual({ command: 'grok', args: ['--model', 'demo'], env: {} })
  })

  it.each(['gemini', 'antigravity'] as const)('launches %s via --prompt-interactive', (id) => {
    const command = id === 'antigravity' ? 'agy' : 'gemini'
    expect(providers.get(id).buildLaunch({
      workspacePath: '/tmp/work', prompt: 'fix "quoted"\ntext', args: ['--yolo'], env: {}
    })).toEqual({ command, args: ['--prompt-interactive', 'fix "quoted"\ntext', '--yolo'], env: {} })
    // No prompt → interactive with no flag.
    expect(providers.get(id).buildLaunch({
      workspacePath: '/tmp/work', prompt: '', args: [], env: {}
    })).toEqual({ command, args: [], env: {} })
  })

  it('launches Cursor with a positional prompt on cursor-agent', () => {
    expect(providers.get('cursor').buildLaunch({
      workspacePath: '/tmp/work', prompt: 'review this', args: ['--force'], env: {}
    })).toEqual({ command: 'cursor-agent', args: ['--force', 'review this'], env: {} })
  })

  it.each(['grok', 'gemini', 'antigravity', 'cursor'] as const)('exposes %s as terminal-only (no resume/hook)', (id) => {
    expect(() => providers.get(id).buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: id, sessionId: 'native-x' },
      prompt: 'continue now',
      args: [],
      env: {}
    })).toThrow('does not support')
  })

  it('plans interactive prompt submission with the Provider terminal protocol', () => {
    expect(providers.get('codex').terminalHandshake).toEqual({
      query: '\u001b[?u',
      response: '\u001b[?0u'
    })
    expect(providers.get('codex').terminalPromptRender).toEqual({
      frameStart: '\u001b[?2026h',
      activeComposer: '›',
      frameEnd: '\u001b[?2026l'
    })
    expect(providers.get('codex').planPromptInput('continue')).toEqual({
      kind: 'render-then-submit', payload: 'continue', submit: '\r'
    })
    for (const id of ['claude', 'traex', 'hermes', 'pi'] as const) {
      expect(providers.get(id).terminalHandshake).toBeUndefined()
      expect(providers.get(id).terminalPromptRender).toBeUndefined()
      expect(providers.get(id).planPromptInput('continue')).toEqual({
        kind: 'single-phase', data: 'continue\r'
      })
    }
  })

  it('probes the selected executable on the execution host', async () => {
    const probes: string[] = []
    await expect(providers.get('claude').probeCapabilities({
      async hasExecutable(executable) {
        probes.push(executable)
        return executable === '/opt/claude'
      }
    }, '/opt/claude')).resolves.toMatchObject({
      providerId: 'claude',
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
      prompt: 'continue now',
      args: ['--model', 'demo'],
      env: {}
    })).toEqual({
      command: 'codex',
      args: ['resume', 'native-1', 'continue now', '--model', 'demo'],
      env: {}
    })
    expect(() => providers.get('pi').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'pi', sessionId: 'native-2' },
      prompt: 'continue now',
      args: [],
      env: {}
    })).toThrow('session file')
    expect(() => providers.get('hermes').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'hermes', sessionId: 'native-3' },
      prompt: 'continue now',
      args: [],
      env: {}
    })).toThrow('does not support')
  })

  it('omits the prompt argv token for semantic continuity recovery', () => {
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
    expect(providers.get('claude').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-2' },
      args: ['--model', 'demo'],
      env: {}
    })).toEqual({
      command: 'claude',
      args: ['--resume', 'native-2', '--model', 'demo'],
      env: {}
    })
    expect(providers.get('pi').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: {
        kind: 'provider',
        providerId: 'pi',
        sessionId: 'native-3',
        transcriptPath: '/tmp/session.jsonl'
      },
      args: [],
      env: {}
    })).toEqual({
      command: 'pi',
      args: ['--session', '/tmp/session.jsonl'],
      env: {}
    })
  })
})
