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
        hook: 'native', permission: 'respond', resume: 'provider-native', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'claude', executable: 'claude', expectedProcess: 'claude',
        promptDelivery: 'positional-argv', readySignal: 'foreground-process',
        hook: 'native', permission: 'respond', resume: 'provider-native', acp: 'none',
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
        hook: 'native', permission: 'observe', resume: 'provider-native', acp: 'none',
        replyCorrelation: 'none'
      },
      {
        id: 'gemini', executable: 'gemini', expectedProcess: 'gemini',
        promptDelivery: 'flag-prompt-interactive', readySignal: 'foreground-process',
        hook: 'native', permission: 'observe', resume: 'provider-native', acp: 'none',
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
        hook: 'native', permission: 'observe', resume: 'provider-native', acp: 'none',
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
    // grok joins them too: its own file under ~/.grok/hooks/ (that directory is always-trusted, so the
    // install needs no folder-trust grant) — see createGrokManagedHookPlan.
    // cursor joins them with TWO mutations: the user-layer ~/.cursor/hooks.json plus the workspace
    // trust marker — see createCursorManagedHookPlan.
    for (const id of ['codex', 'claude', 'antigravity', 'hermes', 'grok', 'gemini', 'cursor'] as const) {
      expect(catalog.get(id)).toEqual({ kind: 'native', installation: 'explicit-managed' })
    }
    // Native hooks AgentMux understands but cannot install yet (pi TS extension has no surface AgentMux
    // writes): it must NOT claim explicit-managed, so the launch-time trigger honestly skips it.
    expect(catalog.get('pi')).toEqual({ kind: 'native', installation: 'unmanaged' })
    // Providers with no hooks at all stay `none`, never a fake native.
    expect(catalog.get('traex')).toEqual({ kind: 'none' })
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

  // grok、gemini、cursor 都已离开这一组：grok 的 `--resume <SESSION_ID_OR_TITLE>` 来自本机 `--help`；
  // gemini 的 `--resume <uuid>` 来自读实现（findSession 是 UUID 优先，help 文本少说了）；cursor 的
  // `--resume [chatId]` 同样来自读 bundle（`else fe=o.resume` 直传 chat id）。三者的 resume argv 分别在
  // test/providers/{grok,gemini,cursor}.test.ts 里断言。
  //
  // 这一组必须留着**真的没有** native resume 的 Provider，否则它会退化成一个不守任何东西的空壳。
  // traex 与 hermes 就是：两者的 `--help` 里都没有任何恢复旗标（hermes 的 resumeStrategy 因此是 none）。
  it.each(['traex', 'hermes'] as const)('exposes %s as not supporting provider-native resume', (id) => {
    expect(providers.get(id).catalog.capabilities.providerResume).toBe(false)
    expect(() => providers.get(id).buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: id, sessionId: 'native-x' },
      prompt: 'continue now',
      args: [],
      env: {}
    })).toThrow('does not support')
  })

  it('publishes grok as the only built-in with an addressable posture control, drawn from its declaration', () => {
    const catalog = new Map(providers.catalog().map((provider) => [provider.id, provider]))

    // grok exposes `/always-approve [on|off]` — two modes, each SET by a distinct in-band slash command.
    // The catalog carries the DESCRIBE half (labels + tiers) and NO keystroke, so a byte never crosses IPC.
    expect(catalog.get('grok')?.postureControl).toEqual({
      id: 'approval',
      label: 'Approvals',
      modes: [
        { id: 'ask', label: 'Ask each time', description: 'Grok asks before running commands or editing files.', tier: 'safe' },
        { id: 'always-approve', label: 'Auto-approve', description: 'Skip all permission prompts for this session.', tier: 'danger' }
      ]
    })
    expect(JSON.stringify(catalog.get('grok')?.postureControl)).not.toContain('/always-approve')

    // Every other built-in exposes only a blind Shift+Tab cycle (or an unnavigable popup), which is not
    // addressable — so it declares no posture control and the composer draws nothing for it.
    for (const id of ['codex', 'claude', 'gemini', 'traex', 'hermes', 'pi', 'antigravity', 'cursor'] as const) {
      expect(catalog.get(id)?.postureControl).toBeUndefined()
    }
  })

  it('resolves grok posture keystrokes core-side and fails closed for providers without a control', () => {
    // grok's mode ids resolve to the exact bytes the CLI needs — a SET, not a blind cycle.
    expect(providers.get('grok').planPostureSet('ask')).toEqual({ data: '/always-approve off\r' })
    expect(providers.get('grok').planPostureSet('always-approve')).toEqual({ data: '/always-approve on\r' })
    // A mode grok does not declare fails closed.
    expect(() => providers.get('grok').planPostureSet('yolo')).toThrow('does not declare')
    // A Provider that declares no posture control refuses the operation rather than emitting a blind key.
    expect(() => providers.get('claude').planPostureSet('always-approve')).toThrow('does not expose a live posture control')
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
      kind: 'render-then-submit', payload: 'continue', renderedText: 'continue', submit: '\r'
    })
    expect(providers.get('codex').planPromptInput('line1\nline2')).toEqual({
      kind: 'render-then-submit',
      payload: '\u001b[200~line1\nline2\u001b[201~',
      renderedText: 'line1\nline2',
      submit: '\r'
    })
    expect(providers.get('codex').planPromptInput('line1\r\nline2')).toMatchObject({
      renderedText: 'line1\nline2'
    })
    expect(providers.get('codex').planPromptInput('text with \u001b escape')).toEqual({
      kind: 'render-then-submit',
      payload: 'text with \u241b escape',
      renderedText: 'text with \u241b escape',
      submit: '\r'
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

  it.each(['codex', 'claude'] as const)(
    'makes %s explicitly own its typed terminal response protocol',
    (providerId) => {
      const provider = providers.get(providerId)
      // Options mirror what each Provider declares, so normalizeAgentInteractionResponse accepts the
      // chosen optionId. Claude's stable three-row prompt earns an allow-always keystroke; Codex's
      // dynamic prompt keeps only the positionally-stable allow-once + deny.
      const options = providerId === 'claude'
        ? [
            { id: 'allow-once', label: 'Allow once', kind: 'allow-once' as const },
            { id: 'allow-always', label: "Allow & don't ask again", kind: 'allow-always' as const },
            { id: 'reject-once', label: 'Deny', kind: 'reject-once' as const }
          ]
        : [
            { id: 'allow-once', label: 'Allow', kind: 'allow-once' as const },
            { id: 'reject-once', label: 'Deny', kind: 'reject-once' as const }
          ]
      const request = {
        kind: 'permission' as const,
        id: `${providerId}-permission`,
        agentSessionId: `${providerId}-session`,
        title: 'Allow command?',
        options,
        evidence: {
          source: 'native-hook' as const,
          observedAt: 1,
          run: { runId: `${providerId}-run` },
          hookReceiptId: `${providerId}-permission`
        }
      }
      const reply = (optionId: string) => provider.planInteractionResponse(request, {
        kind: 'permission' as const,
        requestId: request.id,
        decision: { outcome: 'selected' as const, optionId }
      })
      expect(reply('allow-once')).toEqual({ data: '1' })
      if (providerId === 'claude') expect(reply('allow-always')).toEqual({ data: '2' })
      expect(provider.planInteractionResponse(request, {
        kind: 'permission',
        requestId: request.id,
        decision: { outcome: 'cancelled' }
      })).toEqual({ data: '\u001b' })
    }
  )

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

  it('decides installed from the configured command, staying honest when it changed but is unavailable', async () => {
    // The installed verdict tracks the executable the user actually configured, never a hardcoded
    // provider default and never a string match: pointing the command at a present wrapper reports
    // installed, and pointing it at a path that does not resolve reports not installed. Both halves
    // matter — a bug fix that forced installed to true would be a different dishonesty.
    const probed: string[] = []
    const probe = {
      async hasExecutable(executable: string) {
        probed.push(executable)
        return executable === '/opt/wrappers/my-claude'
      }
    }
    await expect(providers.get('claude').probeCapabilities(probe, '/opt/wrappers/my-claude'))
      .resolves.toMatchObject({ executable: '/opt/wrappers/my-claude', installed: true })
    await expect(providers.get('claude').probeCapabilities(probe, '/opt/wrappers/missing'))
      .resolves.toMatchObject({ executable: '/opt/wrappers/missing', installed: false })
    await expect(providers.get('claude').probeCapabilities(probe))
      .resolves.toMatchObject({ executable: 'claude', installed: false })
    // The exact strings probed are the configured command, not the catalog default, for each call.
    expect(probed).toEqual(['/opt/wrappers/my-claude', '/opt/wrappers/missing', 'claude'])
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

  it('carries the resolved launch posture into resume argv without breaking the positional prompt', () => {
    // The create path appends `resolveLaunchArgv(selection)` after the caller args; resume must do the
    // same so a narrowed sandbox / permission-mode survives the stop/resume boundary rather than
    // reverting to the Provider's default. buildResumeArgs orders these differently per provider — codex
    // places args AFTER the positional prompt, claude BEFORE — and both must stay CLI-valid.
    const codex = providers.get('codex')
    const codexPosture = codex.resolveLaunchArgv({ sandbox: 'read-only', approval: 'never' })
    expect(codexPosture).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never'])
    expect(codex.buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-1' },
      prompt: 'resume now',
      args: codexPosture,
      env: {}
    })).toEqual({
      command: 'codex',
      // Option flags intermix after the positional prompt; clap accepts option/positional intermixing,
      // and `resume now` remains a single positional token.
      args: [
        'resume', 'native-1', '--dangerously-bypass-hook-trust',
        'resume now', '--sandbox', 'read-only', '--ask-for-approval', 'never'
      ],
      env: {}
    })

    const claude = providers.get('claude')
    const claudePosture = claude.resolveLaunchArgv({ 'permission-mode': 'plan' })
    expect(claudePosture).toEqual(['--permission-mode', 'plan'])
    expect(claude.buildResumeLaunch({
      workspacePath: '/tmp/work',
      nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-2' },
      prompt: 'resume now',
      args: claudePosture,
      env: {}
    })).toEqual({
      command: 'claude',
      // Claude places args before the positional prompt, so the flag pair precedes it — still valid.
      args: ['--resume', 'native-2', '--permission-mode', 'plan', 'resume now'],
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
    // 子代理在途压制的产品接线：SubagentStop 必须被真正安装，否则 Provider CLI 永不发这个事件，
    // 花名册永不减一，主 Stop 被永远压住，Agent 卡在 working 出不来。start 同样必须在，否则记不上。
    const parsed = JSON.parse(mutation?.content ?? '{}') as {
      hooks: Record<string, unknown>
    }
    expect(parsed.hooks['SubagentStart']).toBeDefined()
    expect(parsed.hooks['SubagentStop']).toBeDefined()
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
    expect(parsed.hooks['PermissionRequest']?.[0]?.hooks?.[0]?.command).toContain('agentmux-hook.js')
    expect(parsed.hooks['PreToolUse']?.[0]?.matcher).toBe('*')
    // Non-tool lifecycle events carry no matcher.
    expect(parsed.hooks['SessionStart']?.[0]?.matcher).toBeUndefined()
    // 同 Codex：子代理 start/stop 都要安装，否则子代理在途压制在产品上是死的。
    expect(parsed.hooks['SubagentStart']?.[0]?.hooks?.[0]?.command).toContain('agentmux-hook.js')
    expect(parsed.hooks['SubagentStop']?.[0]?.hooks?.[0]?.command).toContain('agentmux-hook.js')
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

  it('projects launch options only for providers that declare them (absence hides the control)', () => {
    const catalog = new Map(providers.catalog().map((provider) => [provider.id, provider.launchOptions]))
    // Each option id, per provider, matches the verified flag it declares. cursor and pi declare none —
    // cursor because its executable exposes no such flag we chose to declare, pi likewise — so the
    // renderer draws no launch control for them (absence hides, never a disabled affordance).
    expect(catalog.get('codex')?.map((option) => option.id)).toEqual(['sandbox', 'approval'])
    // claude declares model + effort ahead of permission-mode; both --model and --effort are enumerated by
    // `claude --help`, so they are honestly declared (declaration order is what resolveLaunchArgv locks).
    expect(catalog.get('claude')?.map((option) => option.id)).toEqual(['model', 'effort', 'permission-mode'])
    expect(catalog.get('gemini')?.map((option) => option.id)).toEqual(['approval-mode'])
    expect(catalog.get('grok')?.map((option) => option.id)).toEqual(['permission-mode'])
    expect(catalog.get('traex')?.map((option) => option.id)).toEqual(['sandbox', 'permission-mode'])
    expect(catalog.get('hermes')?.map((option) => option.id)).toEqual(['yolo'])
    expect(catalog.get('antigravity')?.map((option) => option.id)).toEqual(['sandbox'])
    expect(catalog.get('cursor')?.map((option) => option.id)).toEqual(['mode', 'sandbox', 'approvals'])
    // pi is the one built-in that declares nothing, so the control has nothing to render for it.
    expect(catalog.get('pi')).toEqual([])
  })

  it('projects the DESCRIBE half without leaking any argv across the catalog', () => {
    const codex = new Map(providers.catalog().map((provider) => [provider.id, provider]))
    const sandbox = codex.get('codex')?.launchOptions.find((option) => option.id === 'sandbox')
    expect(sandbox?.choices.map((choice) => choice.id)).toEqual([
      'read-only', 'workspace-write', 'danger-full-access'
    ])
    // The serializable descriptor carries labels/tiers the UI renders, never the launch argv.
    for (const choice of sandbox?.choices ?? []) {
      expect('argv' in choice).toBe(false)
      expect(typeof choice.label).toBe('string')
    }
    expect(sandbox?.choices.find((choice) => choice.id === 'danger-full-access')?.tier).toBe('danger')
  })

  it('resolves declared launch-option argv through the provider and composes two options', () => {
    // Verified against `codex --help`: `--sandbox <mode>` and `--ask-for-approval <policy>`.
    expect(providers.get('codex').resolveLaunchArgv({ sandbox: 'workspace-write' }))
      .toEqual(['--sandbox', 'workspace-write'])
    expect(providers.get('codex').resolveLaunchArgv({ sandbox: 'read-only', approval: 'never' }))
      .toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never'])
    // Verified against `claude --help`: `--model <alias>` enumerates fable/opus/sonnet, `--effort <level>`
    // enumerates low..max, and `--permission-mode <mode>`. Each resolves to its exact flag pair on its own.
    expect(providers.get('claude').resolveLaunchArgv({ 'permission-mode': 'plan' }))
      .toEqual(['--permission-mode', 'plan'])
    expect(providers.get('claude').resolveLaunchArgv({ model: 'opus' }))
      .toEqual(['--model', 'opus'])
    expect(providers.get('claude').resolveLaunchArgv({ effort: 'high' }))
      .toEqual(['--effort', 'high'])
    // All three selected compose in DECLARATION order (model, effort, permission-mode) regardless of the
    // key order the selection was serialized in — this locks the argv the spawn path appends.
    expect(providers.get('claude').resolveLaunchArgv({ 'permission-mode': 'plan', effort: 'max', model: 'sonnet' }))
      .toEqual(['--model', 'sonnet', '--effort', 'max', '--permission-mode', 'plan'])
  })

  it('fails closed when a launch-option selection names an option or choice the provider never declared', () => {
    // A provider with no options rejects any selection rather than silently dropping it.
    expect(() => providers.get('pi').resolveLaunchArgv({ sandbox: 'read-only' }))
      .toThrowError(/does not declare launch option 'sandbox'/)
    // A provider that declares other options still rejects one it never offered.
    expect(() => providers.get('cursor').resolveLaunchArgv({ 'permission-mode': 'plan' }))
      .toThrowError(/does not declare launch option 'permission-mode'/)
    // A declared option rejects an un-offered choice.
    expect(() => providers.get('codex').resolveLaunchArgv({ sandbox: 'yolo' }))
      .toThrowError(/has no choice 'yolo'/)
    // An empty selection contributes nothing.
    expect(providers.get('codex').resolveLaunchArgv({})).toEqual([])
  })

  it('resolves cursor to its verified argv, with the prompt still positional', () => {
    // cursor-agent `--mode <plan|ask>`, `--sandbox <enabled|disabled>`, `--force` — each verified
    // against the installed binary's own --help.
    const cursor = providers.get('cursor')
    const argv = cursor.resolveLaunchArgv({ mode: 'plan', sandbox: 'enabled', approvals: 'force' })
    expect(argv).toEqual(['--mode', 'plan', '--sandbox', 'enabled', '--force'])
    // cursor-agent takes the prompt positionally, so the resolved flags fold in ahead of it.
    expect(cursor.buildLaunch({
      workspacePath: '/repo', prompt: 'ship it', args: argv, env: {}
    }).args).toEqual(['--mode', 'plan', '--sandbox', 'enabled', '--force', 'ship it'])
    // The permissive defaults contribute nothing, leaving the CLI's own default posture intact.
    expect(cursor.resolveLaunchArgv({ mode: 'default', approvals: 'default' })).toEqual([])
  })

  it('resolves the batch-two launch options to their exact verified argv, folded into buildArgs', () => {    // gemini `--approval-mode <default|auto_edit|yolo|plan>` — verified against the installed binary.
    // -y/--yolo is an alias for approval-mode yolo, so it is NOT a second option.
    const gemini = providers.get('gemini')
    expect(gemini.resolveLaunchArgv({ 'approval-mode': 'plan' })).toEqual(['--approval-mode', 'plan'])
    expect(gemini.resolveLaunchArgv({ 'approval-mode': 'yolo' })).toEqual(['--approval-mode', 'yolo'])
    // gemini front-loads --prompt-interactive; the resolved argv folds in AFTER the prompt via buildArgs.
    expect(gemini.buildLaunch({
      workspacePath: '/tmp/work', prompt: 'go', args: gemini.resolveLaunchArgv({ 'approval-mode': 'yolo' }), env: {}
    })).toEqual({ command: 'gemini', args: ['--prompt-interactive', 'go', '--approval-mode', 'yolo'], env: {} })

    // grok `--permission-mode <default|acceptEdits|auto|dontAsk|bypassPermissions|plan>` — verified.
    // The launch option is the spawn-time analogue of grok's live /always-approve posture control.
    const grok = providers.get('grok')
    expect(grok.resolveLaunchArgv({ 'permission-mode': 'bypassPermissions' }))
      .toEqual(['--permission-mode', 'bypassPermissions'])
    // grok's `--` separator still guards a flag-looking prompt with the posture argv folded in.
    expect(grok.buildLaunch({
      workspacePath: '/tmp/work', prompt: '--version', args: grok.resolveLaunchArgv({ 'permission-mode': 'plan' }), env: {}
    })).toEqual({ command: 'grok', args: ['--permission-mode', 'plan', '--', '--version'], env: {} })

    // traex `--sandbox` and `--permission-mode` — full permission-mode enum confirmed by reading the
    // complete --help past the truncating long descriptions: default | bypass_permissions | auto.
    const traex = providers.get('traex')
    expect(traex.resolveLaunchArgv({ sandbox: 'workspace-write' })).toEqual(['--sandbox', 'workspace-write'])
    expect(traex.resolveLaunchArgv({ 'permission-mode': 'bypass_permissions' }))
      .toEqual(['--permission-mode', 'bypass_permissions'])
    // Two options compose in declaration order.
    expect(traex.resolveLaunchArgv({ sandbox: 'read-only', 'permission-mode': 'auto' }))
      .toEqual(['--sandbox', 'read-only', '--permission-mode', 'auto'])

    // hermes `--yolo` is boolean: the conservative default contributes NO argv, the yolo choice the flag.
    const hermes = providers.get('hermes')
    expect(hermes.resolveLaunchArgv({ yolo: 'default' })).toEqual([])
    expect(hermes.resolveLaunchArgv({ yolo: 'yolo' })).toEqual(['--yolo'])
    // Folded into hermes' chat/query/tui argv shape.
    expect(hermes.buildLaunch({
      workspacePath: '/tmp/work', prompt: 'inspect', args: hermes.resolveLaunchArgv({ yolo: 'yolo' }), env: {}
    })).toEqual({ command: 'hermes', args: ['chat', '--query', 'inspect', '--yolo', '--tui'], env: {} })

    // antigravity `--sandbox` is boolean: default off contributes NO argv, sandboxed adds the flag.
    const agy = providers.get('antigravity')
    expect(agy.resolveLaunchArgv({ sandbox: 'default' })).toEqual([])
    expect(agy.resolveLaunchArgv({ sandbox: 'sandboxed' })).toEqual(['--sandbox'])
  })

  it('tiers the batch-two danger choices honestly and never leaks argv through the DESCRIBE half', () => {
    const catalog = new Map(providers.catalog().map((provider) => [provider.id, provider]))
    const tier = (providerId: string, optionId: string, choiceId: string) =>
      catalog.get(providerId)?.launchOptions
        .find((option) => option.id === optionId)?.choices
        .find((choice) => choice.id === choiceId)?.tier
    // A mode that bypasses approval or sandboxing is 'danger'.
    expect(tier('gemini', 'approval-mode', 'yolo')).toBe('danger')
    expect(tier('grok', 'permission-mode', 'bypassPermissions')).toBe('danger')
    expect(tier('traex', 'sandbox', 'danger-full-access')).toBe('danger')
    expect(tier('traex', 'permission-mode', 'bypass_permissions')).toBe('danger')
    expect(tier('hermes', 'yolo', 'yolo')).toBe('danger')
    // agy: enabling the sandbox ADDS containment, so it is the safe tier; the unsandboxed default is caution.
    expect(tier('antigravity', 'sandbox', 'sandboxed')).toBe('safe')
    expect(tier('antigravity', 'sandbox', 'default')).toBe('caution')
    // The conservative default is 'safe'.
    expect(tier('gemini', 'approval-mode', 'default')).toBe('safe')
    expect(tier('grok', 'permission-mode', 'default')).toBe('safe')
    expect(tier('traex', 'sandbox', 'read-only')).toBe('safe')
    // The DESCRIBE half the catalog projects never carries the launch argv.
    for (const providerId of ['gemini', 'grok', 'traex', 'hermes', 'antigravity'] as const) {
      for (const option of catalog.get(providerId)?.launchOptions ?? []) {
        for (const choice of option.choices) {
          expect('argv' in choice).toBe(false)
        }
      }
    }
  })
})
