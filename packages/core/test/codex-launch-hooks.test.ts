import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { CODEX_HOOK_EVENTS, codexHookTrustBypassed } from '@agentmux/providers/codex/launch-hooks'
import { withCodexLaunchHooks, inspectCodexHookActivation } from '../src/providers/codex-hook-services.js'
import { prepareCodexManagedLaunch } from '../src/providers/codex-native-input.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function declarations(args: readonly string[]) {
  const result: Record<string, any> = {}
  for (let index = 0; index < args.length; index += 1) if (args[index] === '-c') {
    const config = args[++index]!
    if (config.startsWith('hooks.')) Object.assign(result, parse(config).hooks)
  }
  return result
}

describe('Codex launch-carried Hook declarations', () => {
  it('carries every native event with the effective timeout, matcher and env-located runner', () => {
    const { args, issue } = withCodexLaunchHooks([])
    expect(issue).toBeUndefined()
    const hooks = declarations(args)
    expect(Object.keys(hooks)).toEqual(CODEX_HOOK_EVENTS)
    for (const event of CODEX_HOOK_EVENTS) {
      expect(hooks[event]).toHaveLength(1)
      expect(hooks[event][0].hooks).toEqual([{ type: 'command', command: expect.stringContaining('"$AGENTMUX_HOOK_NODE" "$AGENTMUX_HOOK_RUNNER" --launch-scoped'),
        timeout: event === 'PermissionRequest' ? 600 : event === 'Interrupt' ? 3 : 10 }])
      expect(hooks[event][0].matcher).toBe(event === 'SessionStart' ? 'startup|resume|clear|compact' : undefined)
    }
    expect(withCodexLaunchHooks(args).args).toEqual(args)
  })

  it('preserves the final user callback array across TOML literals, quoted keys and whole-table overrides', () => {
    const command = `printf "space path" 'one\\two'`
    const args = ['--model', 'original', '-c', 'hooks.Stop=[{hooks=[{type="command",command="superseded"}]}]',
      '--config', 'hooks={"Stop"=[{matcher="user",hooks=[{type="command",command=' + JSON.stringify(command) + ',timeout=31}]}],Future=[]}',
      '--config=hooks."PreToolUse"=[{hooks=[{type=\'command\',command=\'literal $data\'}]}]']
    const configured = withCodexLaunchHooks(args)
    expect(configured.issue).toBeUndefined()
    expect(configured.args.slice(0, args.length)).toEqual(args)
    const hooks = declarations(configured.args.slice(args.length))
    expect(hooks.Stop[0]).toEqual({ matcher: 'user', hooks: [{ type: 'command', command, timeout: 31 }] })
    expect(hooks.Stop).toHaveLength(2)
    expect(hooks.PreToolUse[0].hooks[0].command).toBe('literal $data')
    expect(hooks.PreToolUse).toHaveLength(2)
    expect(withCodexLaunchHooks(configured.args).args).toEqual(configured.args)
  })

  it.each(['--cd', '--model', '--image'])('never turns the opaque %s value into an executable callback', option => {
    const data = '-chooks.Stop=[{hooks=[{type="command",command="printf UNINTENDED"}]}]'
    const original = [option, data]
    const configured = withCodexLaunchHooks(original)
    expect(configured.issue).toBeUndefined()
    expect(configured.args.slice(0, original.length)).toEqual(original)
    const owned = declarations(configured.args.slice(original.length))
    expect(Object.keys(owned)).toEqual(CODEX_HOOK_EVENTS)
    expect(owned.Stop).toHaveLength(1)
    expect(owned.Stop[0].hooks[0].command).not.toContain('UNINTENDED')
  })

  it('keeps an opaque -- boundary unchanged and reports that declarations could not be carried', () => {
    const original = ['--', '-chooks.Stop=[{hooks=[{type="command",command="printf UNINTENDED"}]}]']
    expect(withCodexLaunchHooks(original)).toMatchObject({ args: original, issue: expect.any(String) })
  })

  it.each(['hooks.Stop=unknown', 'hooks.Stop={unexpected=true}', 'hooks=["unknown"]'])('keeps uninterpretable original flags and exposes that exact inspection gap: %s', async config => {
    const args = ['--config', config]
    expect(withCodexLaunchHooks(args)).toMatchObject({ args, issue: expect.any(String) })
    expect(await inspectCodexHookActivation({ args, workspacePath: process.cwd(), command: 'never-spawn-this', env: {},
      plan: { providerId: 'codex', mutations: [] }, signal: new AbortController().signal }))
      .toMatchObject({ active: false, code: 'HOOK_LAUNCH_CONFIGURATION_UNCONFIRMED' })
    const launch = new AgentProviderRegistry().get('codex').buildLaunch({ workspacePath: process.cwd(), prompt: '', args, env: {} })
    expect(launch.args).toEqual([...args, '--dangerously-bypass-hook-trust'])
    expect(launch.hookLaunchIssue).toMatchObject({ code: 'HOOK_LAUNCH_CONFIGURATION_UNCONFIRMED' })
  })

  it('distinguishes the native trust switch from a value, prompt or unknown wrapper option', () => {
    const flag = '--dangerously-bypass-hook-trust'
    expect(codexHookTrustBypassed(['--model', 'original', flag])).toBe(true)
    expect(codexHookTrustBypassed(['--model', flag])).toBe(false)
    expect(codexHookTrustBypassed(['--config', 'model="' + flag + '"'])).toBe(false)
    expect(codexHookTrustBypassed(['--', flag])).toBe(false)
    expect(codexHookTrustBypassed(['--future-option', flag])).toBe(false)
  })

  it('carries the same declarations on create, resume and fork without a workspace install plan', () => {
    const provider = new AgentProviderRegistry().get('codex')
    const context = { workspacePath: '/private/native-work', args: ['--model', 'original'], prompt: 'literal --config data', env: {},
      nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: '00000000-0000-4000-8000-000000000001' } }
    expect(provider.catalog.hookStrategy).toEqual({ kind: 'native', installation: 'launch-carried' })
    expect(provider.planManagedHooks).toBeUndefined()
    for (const plan of [provider.buildLaunch(context), provider.buildResumeLaunch(context), provider.buildForkLaunch!(context)]) {
      expect(Object.keys(declarations(plan.args))).toEqual(CODEX_HOOK_EVENTS)
      expect(plan.args.slice(-2)).toEqual(['--', context.prompt])
      expect(plan.args).toContain('--dangerously-bypass-hook-trust')
    }
  })

  it.runIf(process.platform === 'darwin')('forwards generated Hook flags into the managed app-server on create and resume without disqualifying YOLO', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-codex-hook-managed-')); roots.push(root)
    const command = join(root, 'native-fixture')
    await writeFile(command, '#!/usr/bin/env node\nconsole.log("codex-cli 0.163.0")\n', { mode: 0o700 })
    const provider = new AgentProviderRegistry().get('codex')
    const context = { workspacePath: root, args: ['--dangerously-bypass-approvals-and-sandbox'], prompt: 'original prompt', env: {}, commandOverride: command,
      nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: '00000000-0000-4000-8000-000000000001' } }
    for (const kind of ['create', 'resume'] as const) {
      const launch = kind === 'create' ? provider.buildLaunch(context) : provider.buildResumeLaunch(context)
      const prepared = await prepareCodexManagedLaunch(launch, 'hook-managed-' + kind, { kind, prompt: context.prompt })
      expect(prepared.nativeActor?.launch).toEqual({ command, args: launch.args })
      const config = JSON.parse(prepared.plan.args[1]!)
      expect(Object.keys(declarations(config.serverConfig))).toEqual(CODEX_HOOK_EVENTS)
      expect(config.frontendArgs).toEqual(['--dangerously-bypass-hook-trust'])
      expect(config[kind].sandbox).toBe('danger-full-access')
      expect(config[kind].approvalPolicy).toBe('never')
    }
  })
})
