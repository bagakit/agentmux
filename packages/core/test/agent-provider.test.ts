import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { AgentProviderRegistry, createAntigravityManagedHookPlan, createClaudeManagedHookPlan, createCodexManagedHookPlan, createHermesManagedHookPlan, resolveManagedHookPlan } from '../src/agent-provider.js'

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
        hook: 'native', permission: 'observe', resume: 'provider-native', acp: 'none',
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

  it('distinguishes explicit-managed hook install from unmanaged native providers', () => {
    const catalog = new Map(providers.catalog().map((provider) => [provider.id, provider.hookStrategy]))
    // AgentMux writes and owns these providers' hook config. Hermes joins them: AgentMux merges its
    // shell hooks into ~/.hermes/config.yaml plus the consent allowlist (see createHermesManagedHookPlan).
    for (const id of ['codex', 'claude', 'antigravity', 'hermes'] as const) {
      expect(catalog.get(id)).toEqual({ kind: 'native', installation: 'explicit-managed' })
    }
    // Native hooks AgentMux understands but cannot install yet (pi TS extension has no surface AgentMux
    // writes): it must NOT claim explicit-managed, so the launch-time trigger honestly skips it.
    expect(catalog.get('pi')).toEqual({ kind: 'native', installation: 'unmanaged' })
    // Providers with no hooks at all stay `none`, never a fake native.
    for (const id of ['traex', 'grok', 'gemini', 'cursor'] as const) {
      expect(catalog.get(id)).toEqual({ kind: 'none' })
    }
  })

  it.each(['claude', 'traex', 'pi'] as const)('delivers %s prompts as positional argv data', (id) => {
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

  it('delivers codex prompts with hook trust bypass', () => {
    const plan = providers.get('codex').buildLaunch({
      workspacePath: '/tmp/work',
      prompt: 'fix "quoted"\ntext',
      args: ['--model', 'demo'],
      env: {}
    })
    expect(plan).toEqual({
      command: 'codex',
      args: ['--model', 'demo', '--dangerously-bypass-hook-trust', 'fix "quoted"\ntext'],
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
    expect(plan.args).toEqual(['--dangerously-bypass-hook-trust', '$(touch /tmp/not-executed)'])
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

  it.each(['grok', 'gemini', 'cursor'] as const)('exposes %s as not supporting provider-native resume', (id) => {
    expect(() => providers.get(id).buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: id, sessionId: 'native-x' },
      prompt: 'continue now',
      args: [],
      env: {}
    })).toThrow('does not support')
  })

  it('builds Antigravity resume launch with --conversation and --prompt-interactive', () => {
    const plan = providers.get('antigravity').buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'antigravity', sessionId: 'conv-123' },
      prompt: 'continue this task',
      args: ['--effort', 'high'],
      env: {}
    })
    expect(plan).toEqual({
      command: 'agy',
      args: ['--conversation', 'conv-123', '--effort', 'high', '--prompt-interactive', 'continue this task'],
      env: {}
    })
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
    expect(providers.get('codex').planPromptInput('line1\nline2')).toEqual({
      kind: 'render-then-submit', payload: '\u001b[200~line1\nline2\u001b[201~', submit: '\r'
    })
    expect(providers.get('codex').planPromptInput('text with \u001b escape')).toEqual({
      kind: 'render-then-submit', payload: 'text with \u241b escape', submit: '\r'
    })
    for (const id of ['claude', 'traex', 'hermes', 'pi'] as const) {
      expect(providers.get(id).terminalHandshake).toBeUndefined()
      expect(providers.get(id).terminalPromptRender).toBeUndefined()
      expect(providers.get(id).planPromptInput('continue')).toEqual({
        kind: 'single-phase', data: 'continue\r'
      })
      expect(providers.get(id).planPromptInput('line1\nline2')).toEqual({
        kind: 'single-phase', data: 'line1\nline2\r'
      })
      expect(providers.get(id).planPromptInput('text with \u001b escape')).toEqual({
        kind: 'single-phase', data: 'text with \u001b escape\r'
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
      args: ['resume', 'native-1', '--dangerously-bypass-hook-trust', 'continue now', '--model', 'demo'],
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
      args: ['resume', 'native-1', '--dangerously-bypass-hook-trust', '--model', 'demo'],
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

  it('normalizes Antigravity hook events into structured activity and states', () => {
    const provider = providers.get('antigravity')
    const preInvocation = provider.normalizeHook({
      providerId: 'antigravity',
      agentSessionId: 'agy-session-1',
      runId: 'agy-run-1',
      receiptId: 'rcpt-1',
      eventName: 'PreInvocation',
      payload: { conversationId: 'native-agy-1', transcript_path: '/tmp/agy.jsonl' }
    })
    expect(preInvocation.status.state).toBe('working')
    expect(preInvocation.nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'antigravity',
      sessionId: 'native-agy-1',
      transcriptPath: '/tmp/agy.jsonl'
    })

    const toolUse = provider.normalizeHook({
      providerId: 'antigravity',
      agentSessionId: 'agy-session-1',
      runId: 'agy-run-1',
      receiptId: 'rcpt-2',
      eventName: 'PreToolUse',
      payload: { tool_name: 'ask_question', tool_input: { prompt: 'Allow write?' } }
    })
    expect(toolUse.status.state).toBe('waiting')
    expect(toolUse.timeline).toHaveLength(1)
    const toolMutation = toolUse.timeline[0]
    expect(toolMutation?.type).toBe('append')
    if (toolMutation?.type === 'append') {
      expect(toolMutation.item.kind).toBe('permission')
    }

    const stop = provider.normalizeHook({
      providerId: 'antigravity',
      agentSessionId: 'agy-session-1',
      runId: 'agy-run-1',
      receiptId: 'rcpt-3',
      eventName: 'Stop',
      payload: { last_assistant_message: 'Done all work.' }
    })
    expect(stop.status.state).toBe('done')
    expect(stop.timeline).toHaveLength(1)
    const stopMutation = stop.timeline[0]
    expect(stopMutation?.type).toBe('append')
    if (stopMutation?.type === 'append') {
      expect(stopMutation.item.kind).toBe('assistant_message')
      expect(stopMutation.item.content).toBe('Done all work.')
    }
  })

  it('generates Antigravity managed hook plan with global path, agentmux-status bundle, and tool schemas', () => {
    const plan = createAntigravityManagedHookPlan('/tmp/fake-home')
    expect(plan.providerId).toBe('antigravity')
    expect(plan.mutations).toHaveLength(1)
    const mutation = plan.mutations[0]
    expect(mutation?.path).toBe('/tmp/fake-home/.gemini/config/hooks.json')
    const parsed = JSON.parse(mutation?.content ?? '{}') as {
      'agentmux-status': Record<string, Array<{ type?: string; matcher?: string; hooks?: unknown[]; command?: string }>>
    }
    const bundle = parsed['agentmux-status']
    expect(bundle).toBeDefined()
    expect(bundle['PreInvocation']?.[0]?.type).toBe('command')
    expect(bundle['PreInvocation']?.[0]?.command).toContain('--event PreInvocation')
    expect(bundle['PreToolUse']?.[0]?.matcher).toBe('*')
    expect(bundle['PreToolUse']?.[0]?.hooks?.[0]).toMatchObject({ type: 'command' })
    // The shared ~/.gemini file must be merged, not overwritten — AgentMux owns only its bundle key.
    expect(mutation?.merge).toEqual({ kind: 'json-owned-key', key: 'agentmux-status' })
  })

  it('declares Codex managed hooks as a marker-scoped merge so committed project hooks survive', () => {
    const mutation = createCodexManagedHookPlan('/tmp/work').mutations[0]
    expect(mutation?.merge).toEqual({ kind: 'json-managed-events', marker: 'agentmux-hook.js' })
  })

  it('generates a workspace-scoped Claude settings.json merge that preserves foreign settings', () => {
    const plan = createClaudeManagedHookPlan('/tmp/work')
    expect(plan.providerId).toBe('claude')
    const mutation = plan.mutations[0]
    expect(mutation?.path).toBe('/tmp/work/.claude/settings.json')
    // Claude keeps hooks under a top-level `hooks` key alongside permissions/model/MCP — like Codex,
    // AgentMux owns only its marked command entries, so the whole file cannot be replaced.
    expect(mutation?.merge).toEqual({ kind: 'json-managed-events', marker: 'agentmux-hook.js' })
    const parsed = JSON.parse(mutation?.content ?? '{}') as {
      hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>>
    }
    expect(parsed.hooks['SessionStart']?.[0]?.hooks?.[0]?.command).toContain('agentmux-hook.js')
    expect(parsed.hooks['PreToolUse']?.[0]?.matcher).toBe('*')
    // Non-tool lifecycle events carry no matcher.
    expect(parsed.hooks['SessionStart']?.[0]?.matcher).toBeUndefined()
  })

  it('resolves the managed hook plan for JSON- and YAML-config native providers, null for the rest', () => {
    // JSON-config providers: codex and claude write into the workspace, antigravity into global ~/.gemini.
    expect(resolveManagedHookPlan('codex', '/tmp/work')?.mutations[0]?.path).toBe('/tmp/work/.codex/hooks.json')
    expect(resolveManagedHookPlan('claude', '/tmp/work')?.mutations[0]?.path).toBe('/tmp/work/.claude/settings.json')
    expect(resolveManagedHookPlan('antigravity', '/tmp/work')?.providerId).toBe('antigravity')
    // hermes writes into its global ~/.hermes: the YAML config plus the consent allowlist (two mutations).
    const hermesPlan = resolveManagedHookPlan('hermes', '/tmp/work')
    expect(hermesPlan?.providerId).toBe('hermes')
    expect(hermesPlan?.mutations.map((mutation) => mutation.path.replace(homedir(), '~'))).toEqual([
      '~/.hermes/config.yaml',
      '~/.hermes/shell-hooks-allowlist.json'
    ])
    expect(hermesPlan?.mutations[0]?.merge).toEqual({ kind: 'yaml-managed-events', marker: 'agentmux-hook.js' })
    expect(hermesPlan?.mutations[1]?.merge).toEqual({ kind: 'json-managed-approvals', marker: 'agentmux-hook.js' })
    // A launch env carrying HERMES_HOME repoints the install to that dir directly (no `.hermes` append) —
    // hermes reads its config dir from $HERMES_HOME, so the installer must target the same dir the process
    // will read. This is the isolation lever the real-hermes e2e leans on.
    const scopedPlan = resolveManagedHookPlan('hermes', '/tmp/work', { HERMES_HOME: '/tmp/scratch-hermes' })
    expect(scopedPlan?.mutations.map((mutation) => mutation.path)).toEqual([
      '/tmp/scratch-hermes/config.yaml',
      '/tmp/scratch-hermes/shell-hooks-allowlist.json'
    ])
    // pi (TypeScript extension) declares native hooks but has no plan builder, so it resolves to null and
    // is not auto-installed. Non-hook providers likewise.
    expect(resolveManagedHookPlan('pi', '/tmp/work')).toBeNull()
    expect(resolveManagedHookPlan('traex', '/tmp/work')).toBeNull()
  })

  it('bakes the packaged-Electron node runner and provider id into the managed hook command', () => {
    // process.execPath is the Electron app binary when packaged; ELECTRON_RUN_AS_NODE=1 makes it run
    // the .js as Node (and a real node binary ignores the var). AGENTMUX_HOOK_PROVIDER lets the shared
    // hook binary emit the provider-correct decision schema without confusing antigravity with gemini.
    const codexCommand = (
      JSON.parse(createCodexManagedHookPlan('/tmp/work').mutations[0]?.content ?? '{}') as {
        hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
      }
    ).hooks['SessionStart']?.[0]?.hooks?.[0]?.command ?? ''
    expect(codexCommand).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(codexCommand).toContain("AGENTMUX_HOOK_PROVIDER='codex'")
    expect(codexCommand).toContain('agentmux-hook.js')

    const antigravityCommand = (
      JSON.parse(createAntigravityManagedHookPlan('/tmp/fake-home').mutations[0]?.content ?? '{}') as {
        'agentmux-status': Record<string, Array<{ command?: string }>>
      }
    )['agentmux-status']['PreInvocation']?.[0]?.command ?? ''
    expect(antigravityCommand).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(antigravityCommand).toContain("AGENTMUX_HOOK_PROVIDER='antigravity'")
  })

  it('prefixes /usr/bin/env for hermes so the env assignments survive shlex.split under shell=False', () => {
    // hermes execs a shell hook as `subprocess.run(shlex.split(command), shell=False)`, so the bare
    // `VAR=val exec …` prefix the other providers use would make `ELECTRON_RUN_AS_NODE=1` argv[0].
    // `/usr/bin/env` parses the NAME=value operands itself, then execs the interpreter with them applied.
    const command = (
      JSON.parse(createHermesManagedHookPlan({ HERMES_HOME: '/tmp/fake-home' }).mutations[0]?.content ?? '{}') as {
        hooks: Record<string, Array<{ command?: string }>>
      }
    ).hooks['pre_tool_call']?.[0]?.command ?? ''
    expect(command.startsWith('/usr/bin/env ')).toBe(true)
    expect(command).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(command).toContain("AGENTMUX_HOOK_PROVIDER='hermes'")
    expect(command).toContain('agentmux-hook.js')
    // The allowlist approval must gate the SAME command string, byte-for-byte — hermes matches (event,
    // command) exactly, so any divergence would leave the hook un-approved and silently skipped.
    const approvals = (
      JSON.parse(createHermesManagedHookPlan({ HERMES_HOME: '/tmp/fake-home' }).mutations[1]?.content ?? '{}') as {
        approvals: Array<{ event?: string; command?: string }>
      }
    ).approvals
    expect(approvals).toContainEqual({ event: 'pre_tool_call', command })
    // Approvals carry ONLY {event, command} — no timestamps — so the merge stays pure for the installer's
    // unchanged-hash guard, and we never write the global auto-accept opt-in.
    expect(approvals.every((approval) => Object.keys(approval).sort().join(',') === 'command,event')).toBe(true)
  })
})
