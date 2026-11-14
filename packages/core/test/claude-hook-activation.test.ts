import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectClaudeHookSettings } from '../src/providers/claude-native-settings.js'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

const workspacePath = '/private/claude-hook-workspace'
const home = '/private/claude-hook-home'
const files = new Map<string, string>()
const inspect = (args: string[] = [], env: Record<string, string> = {}) => inspectClaudeHookSettings({
  workspacePath, args, env: { HOME: home, CLAUDE_CONFIG_DIR: '', CLAUDE_CODE_SAFE_MODE: '', ...env },
  signal: new AbortController().signal
})
const put = (path: string, value: unknown) => files.set(path, JSON.stringify(value))

beforeEach(() => {
  files.clear()
  vi.mocked(readFile).mockImplementation(async path => {
    const text = files.get(String(path))
    if (text !== undefined) return text
    throw Object.assign(new Error('not present'), { code: 'ENOENT' })
  })
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('Claude launch-carried Hook activation sources', () => {
  it('uses the highest source defining the key rather than a lower user disable', async () => {
    put(home + '/.claude/settings.json', { disableAllHooks: true })
    put(workspacePath + '/.claude/settings.json', { disableAllHooks: false })
    expect(await inspect()).toMatchObject({ active: true })
    put(workspacePath + '/.claude/settings.local.json', { disableAllHooks: true })
    expect(await inspect()).toMatchObject({ active: false, code: 'HOOK_CONFIGURATION_DISABLED' })
    expect(await inspect(['--settings', '{"disableAllHooks":false}'])).toMatchObject({ active: true })
    expect(await inspect(['--settings', '{"disableAllHooks":false}', '--settings={"disableAllHooks":true}']))
      .toMatchObject({ active: false })
  })

  it('honors --setting-sources and the literal -- boundary', async () => {
    put(workspacePath + '/.claude/settings.local.json', { disableAllHooks: true })
    expect(await inspect(['--setting-sources', 'user'])).toMatchObject({ active: true })
    expect(await inspect(['--setting-sources='])).toMatchObject({ active: true })
    expect(await inspect(['--', '--setting-sources='])).toMatchObject({ active: false })
  })

  it('keeps other option values opaque even when they resemble activation flags', async () => {
    put(home + '/.claude/settings.json', { disableAllHooks: true })
    expect(await inspect(['--system-prompt', '--settings={"disableAllHooks":false}'])).toMatchObject({ active: false })
    expect(await inspect(['--system-prompt', '--setting-sources='])).toMatchObject({ active: false })
    expect(await inspect(['--setting-sources=', '--system-prompt', '--safe-mode'])).toMatchObject({ active: true })
  })

  it('resolves explicit launch settings relative to the exact workspace and fails for a missing explicit file', async () => {
    put(workspacePath + '/options.json', { disableAllHooks: true })
    expect(await inspect(['--settings', 'options.json'])).toMatchObject({ active: false })
    await expect(inspect(['--settings', 'missing.json'])).rejects.toMatchObject({ code: 'HOOK_TARGET_UNPARSEABLE' })
  })

  it('uses the configured user root and inherits the launching process override', async () => {
    put('/private/custom-claude/settings.json', { disableAllHooks: true })
    expect(await inspect([], { CLAUDE_CONFIG_DIR: '/private/custom-claude' })).toMatchObject({ active: false })
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/private/custom-claude')
    expect(await inspectClaudeHookSettings({ workspacePath, args: [], env: { HOME: home },
      signal: new AbortController().signal })).toMatchObject({ active: false })
  })

  it('keeps an explicitly unset inherited user root and resolves HOME relative to the launch workspace', async () => {
    vi.stubEnv('HOME', '/private/core-home')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/private/core-claude-config')
    const target = workspacePath + '/private-home/.claude/settings.json'
    put(target, { disableAllHooks: true })
    expect(await inspectClaudeHookSettings({ workspacePath, args: [], env: {
      HOME: 'private-home', CLAUDE_CONFIG_DIR: undefined, CLAUDE_CODE_SAFE_MODE: ''
    }, signal: new AbortController().signal }))
      .toMatchObject({ active: false, code: 'HOOK_CONFIGURATION_DISABLED' })
    const reads = vi.mocked(readFile).mock.calls
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.some(([path]) => path === target)).toBe(true)
    expect(reads.some(([path]) => String(path).startsWith('/private/core-home/') ||
      String(path).startsWith('/private/core-claude-config/'))).toBe(false)
  })

  it.each(['disableAllHooks', 'allowManagedHooksOnly', 'disableSideloadFlags'])('keeps managed %s authoritative over launch settings', async key => {
    const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : process.platform === 'win32' ? (process.env.ProgramFiles || 'C:\\Program Files') + '\\ClaudeCode\\managed-settings.json'
      : '/etc/claude-code/managed-settings.json'
    put(managed, { [key]: true })
    expect(await inspect(['--settings', '{"disableAllHooks":false}'])).toMatchObject({ active: false })
  })

  it('reports malformed selected settings as unknown instead of active', async () => {
    files.set(workspacePath + '/.claude/settings.local.json', '{')
    await expect(inspect()).rejects.toMatchObject({ code: 'HOOK_TARGET_UNPARSEABLE' })
    expect(await inspect(['--setting-sources=user'])).toMatchObject({ active: true })
  })

  it('recognizes explicit safe mode without interpreting prompt text as a flag', async () => {
    expect(await inspect(['--safe-mode'])).toMatchObject({ active: false })
    for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) expect(await inspect([], { CLAUDE_CODE_SAFE_MODE: value })).toMatchObject({ active: false })
    for (const value of ['0', 'false', 'no', 'off', 'unrelated']) expect(await inspect([], { CLAUDE_CODE_SAFE_MODE: value })).toMatchObject({ active: true })
    expect(await inspect(['--', '--safe-mode'])).toMatchObject({ active: true })
  })
})
