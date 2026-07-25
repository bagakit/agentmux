import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentManagedHookInstaller, createHermesManagedHookPlan } from '../dist/index.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

/**
 * A deliberately invalid key. hermes fires its hooks while building the first turn — BEFORE the
 * inference request — so the managed-hook path runs in full and the request then dies at HTTP 401.
 * No tokens are ever billed, which is what keeps this test free to run.
 */
const DUMMY_API_KEY = 'sk-ant-agentmux-real-hermes-e2e-invalid'

const MANAGED_EVENTS = [
  'on_session_start',
  'pre_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'post_llm_call',
  'on_session_end'
] as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
}, 30_000)

describe.runIf(process.env.AGENTMUX_REAL_HERMES_E2E === '1')('installed real hermes managed hooks', () => {
  it('installs into the launch-scoped HERMES_HOME and the real binary accepts and fires them', async () => {
    const requestedCommand = process.env.AGENTMUX_REAL_HERMES_COMMAND ?? 'hermes'
    const command = (await execFileAsync('which', [requestedCommand], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    })).stdout.trim()
    const version = await execFileAsync(command, ['--version'], { timeout: 30_000, maxBuffer: 64 * 1024 })
    const versionText = `${version.stdout}${version.stderr}`.trim()
    if (!/Hermes Agent v\d+\./u.test(versionText)) {
      throw new Error(`REAL_HERMES_E2E_UNAVAILABLE: executable=${command} version=${versionText}`)
    }

    const root = await mkdtemp('/private/tmp/agentmux-real-hermes-')
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { mode: 0o700 })

    // hermes resolves its config dir from $HERMES_HOME, and a machine-global overlay at
    // $HERMES_MANAGED_DIR would otherwise win over user config. Pointing HERMES_HOME at a scratch dir
    // and HERMES_MANAGED_DIR at a nonexistent one keeps this test entirely off the developer's real
    // ~/.hermes, which holds their credentials, sessions, and memories.
    const hermesHome = join(root, 'hermes-home')
    await mkdir(hermesHome, { recursive: true, mode: 0o700 })
    const launchEnv = {
      HERMES_HOME: hermesHome,
      HERMES_MANAGED_DIR: join(root, 'hermes-managed-absent'),
      ANTHROPIC_API_KEY: DUMMY_API_KEY
    }

    // The behaviour under test: the plan follows the launch env, never the developer's real home.
    const plan = createHermesManagedHookPlan(launchEnv)
    expect(plan.mutations.map((mutation) => mutation.path)).toEqual([
      join(hermesHome, 'config.yaml'),
      join(hermesHome, 'shell-hooks-allowlist.json')
    ])
    for (const mutation of plan.mutations) {
      expect(mutation.path.startsWith(join(homedir(), '.hermes'))).toBe(false)
    }

    const installer = new AgentManagedHookInstaller(join(root, 'hook-state'))
    const preview = await installer.preview(plan)
    expect(preview.changes.map((change) => change.action)).toEqual(['create', 'create'])
    const receipt = await installer.install(preview.id)
    expect(await readFile(join(hermesHome, 'config.yaml'), 'utf8')).toContain('agentmux-hook.js')

    // The real binary must accept what we wrote: every managed event has to read back as configured
    // AND consent-approved, or hermes would silently skip the hook at runtime. hermes matches the
    // allowlist on the exact (event, command) pair, so this is the assertion that catches drift.
    const listed = await execFileAsync(command, ['hooks', 'list'], {
      env: { ...process.env, ...launchEnv },
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    })
    const listedText = `${listed.stdout}${listed.stderr}`
    for (const eventName of MANAGED_EVENTS) expect(listedText).toContain(`[${eventName}]`)
    expect(listedText).toContain('agentmux-hook.js')
    expect(listedText.match(/✓ allowed/gu) ?? []).toHaveLength(MANAGED_EVENTS.length)

    // Firing for real. `-z` (oneshot) is used deliberately: hermes' TUI ignores a startup query and
    // parks at an empty composer, so oneshot is the only way to begin a turn without a human typing.
    const fired = await execFileAsync(
      command,
      ['-z', 'reply with READY', '-m', 'claude-3-5-haiku-20241022', '--provider', 'anthropic'],
      { cwd: workspace, env: { ...process.env, ...launchEnv }, timeout: 180_000, maxBuffer: 1024 * 1024 }
    ).catch((error: unknown) => error as { stdout?: string; stderr?: string })
    // The turn must die at auth, never on a spend — that is what keeps this test free to run.
    expect(`${fired.stdout ?? ''}${fired.stderr ?? ''}`).toMatch(/401|Unauthorized/u)

    // hermes records each hook it ran; doctor reports them against the same scratch config.
    const doctor = await execFileAsync(command, ['hooks', 'doctor'], {
      env: { ...process.env, ...launchEnv },
      timeout: 120_000,
      maxBuffer: 1024 * 1024
    }).catch((error: unknown) => error as { stdout?: string; stderr?: string })
    expect(`${doctor.stdout ?? ''}${doctor.stderr ?? ''}`).toContain('agentmux-hook.js')

    // Install-and-leave is the production contract; uninstall here only exercises the reverse path.
    await installer.uninstall(receipt)
  }, 420_000)
})
