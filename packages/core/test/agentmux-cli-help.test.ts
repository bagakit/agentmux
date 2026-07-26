import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
async function run(args: readonly string[]): Promise<string> {
  return (await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024 })).stdout
}
async function fail(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  try { await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024, env: { ...process.env, ...env } }) } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number }
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code }
  }
  throw new Error('CLI unexpectedly succeeded.')
}

describe('agentmux CLI discovery', () => {
  it('exposes only the intent-based Control surface', async () => {
    const help = await run(['--help'])
    expect(help).toContain('typed local Agent and Desktop control')
    expect(help).toContain('inspect')
    expect(help).toContain('open')
    expect(help).toContain('send')
    expect(help).toContain('focus')
    expect(help).toContain('arrange')
    expect(help).toContain('AGENTMUX_AGENT_SESSION_ID')
    expect(help).not.toContain('Composition:')
  })

  it('documents typed targets and exact destinations without contacting owners', async () => {
    expect(await run(['inspect', '--help'])).toContain('inspect --tab <tab-id|self>')
    const open = await run(['open', '--help'])
    expect(open).toContain('agentmux open terminal')
    expect(open).toContain('--left-of <region-id|self>')
    expect(open).toContain('--right-of <region-id|self>')
    expect(open).toContain('--above <region-id|self>')
    expect(open).toContain('--below <region-id|self>')
    expect(open).toContain('--new-tab-after <tab-id|self>')
    expect(open).toContain('--in-region <launcher-region-id>')
    expect(await run(['open', 'agent', '--help'])).toContain('--right-of <region-id|self>')
    expect(await run(['open', 'terminal', '--help'])).toContain('--command <shell-command>')
    expect(await run(['open', 'browser', '--help'])).toContain('--url <url>')
    expect(await run(['arrange', '--help'])).toContain('grid-9')
    const send = await run(['send', '--help'])
    expect(send).toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(send).toContain('never resumes')
  })

  it('prints bounded Agent instructions for inspect, open, and send', async () => {
    const skill = await run(['--skill'])
    expect(skill).toContain('agentmux inspect --tab self')
    expect(skill).toContain('agentmux open agent --agent codex')
    expect(skill).toContain('agentmux send --to-tab <tab-id>')
    expect(skill).toContain('agentmux open terminal --command')
    expect(skill).toContain('agentmux open browser --url')
    expect(skill).toContain('agentmux arrange --tab self --preset columns-3')
    expect(skill).toContain('agentmux arrange --tab self --preset grid-4')
    expect(skill).toContain('agentmux arrange --tab self --preset grid-9')
    expect(skill).toContain('--left-of <region-id>')
    expect(skill).toContain('--above <region-id>')
    expect(skill).toContain('--in-region <launcher-region-id>')
    expect(skill).toContain('deduplicating every caller Region')
    expect(skill).toContain('schemaVersion')
    expect(skill).toContain('candidates[].agentSessionId')
    expect(skill).toContain('Send never broadcasts and never resumes')
    expect(skill).toContain('No failure')
  })

  it('deletes old command trees and requires managed identity for self', async () => {
    const unmanaged = await fail(['inspect', '--tab', 'self'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    expect(JSON.parse(unmanaged.stderr)).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    for (const old of [['context'], ['launch'], ['session', 'list'], ['region', 'focus']]) {
      const retired = await fail(old)
      expect(JSON.parse(retired.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
  })

  it('accepts inline typed flag values and keeps self reserved for selector syntax', async () => {
    const unmanaged = await fail(['inspect', '--tab=self'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    expect(JSON.parse(unmanaged.stderr)).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    const exactOnly = await fail(['focus', '--tab=self'])
    expect(JSON.parse(exactOnly.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    const inlineDashId = await fail(['focus', '--tab=--prefixed-tab'])
    expect(['CONTROL_UNAVAILABLE', 'TAB_NOT_OPEN', 'CONTROL_FAILED']).toContain(JSON.parse(inlineDashId.stderr).error?.code)
  })

  it('rejects missing and unrelated native identity companion flags', async () => {
    for (const args of [
      ['inspect', '--provider-native', 'native-id'],
      ['inspect', '--session', 'session-id', '--provider', 'codex'],
      ['inspect', '--acp-native', 'native-id'],
      ['inspect', '--run', 'run-id', '--adapter', 'acp']
    ]) {
      const failure = await fail(args)
      expect(JSON.parse(failure.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
  })

  // doctor 报告里的 endpoint 目录占用与回收结果，若没有一个用户真能敲出来的入口，就等于算了没人看
  // ——占用只能等磁盘告警才发现，回收失败完全无声。这条证明命令真的被 main() 分发到了：跑不通运行时
  // 会得到 typed 失败（本机没有 Desktop Host 时的正常结果），而**未注册**的命令得到的是
  // INVALID_CLI_ARGUMENT + "Unknown command"。两者可区分，所以这条不会因为环境没跑 Host 而假绿。
  it('dispatches doctor as a real command, not an unknown one', async () => {
    const help = await run(['--help'])
    expect(help).toContain('doctor')

    let payload: { ok?: boolean; error?: { code?: string; message?: string } }
    try {
      payload = JSON.parse(await run(['doctor']))
    } catch (error) {
      payload = JSON.parse((error as { stdout: string; stderr: string }).stderr)
    }
    expect(payload.error?.message ?? '').not.toContain('Unknown command')
    expect(payload.error?.code).not.toBe('INVALID_CLI_ARGUMENT')

    // 参数校验也证明分发到位：未注册的命令根本走不到这句错误。
    const extra = await fail(['doctor', 'extra'])
    expect(JSON.parse(extra.stderr)).toMatchObject({
      error: { code: 'INVALID_CLI_ARGUMENT', message: 'doctor takes no arguments.' }
    })
  })

  it('reports the installed CLI version', async () => {
    await expect(run(['--version'])).resolves.toBe('agentmux 0.1.0\n')
  })

  // T-004 验收 #1：whoami 进入既有的 verb 注册、help 与分发，不另起一套。这些断言区分"真的分发到了
  // whoamiCommand"与"落进了 Unknown command 兜底"——两者可区分，所以不会因为本机没跑 Desktop Host
  // 而假绿（未注册命令得到的是 INVALID_CLI_ARGUMENT + "Unknown command"）。
  it('lists whoami in --help and resolves whoami --help through the shared registry', async () => {
    const help = await run(['--help'])
    expect(help).toContain('whoami')
    // whoami --help 走的是与其它 verb 同一个 agentMuxCommandHelp 注册表，不另写一套。
    const whoamiHelp = await run(['whoami', '--help'])
    expect(whoamiHelp).toContain('agentmux whoami')
    // 语法的唯一真相在 skill：per-verb help 说明 Topic 为何不由 verb 产出、指向文件。
    expect(whoamiHelp).toContain('topic.md')
  })

  it('documents whoami in --skill as the startup orientation step, not a second dispatch', async () => {
    const skill = await run(['--skill'])
    expect(skill).toContain('agentmux whoami')
    // skill 是确切用法的唯一真相——whoami 的坐标各项在这里被点到。
    expect(skill).toContain('Session')
    expect(skill).toContain('capabilities')
  })

  it('dispatches whoami as a real command that requires a managed caller, not an unknown one', async () => {
    // 无 managed 身份时 whoami 必须走到 MANAGED_AGENT_CONTEXT_REQUIRED——证明它被分发到了
    // whoamiCommand（managedCaller() 在那里抛），而不是落进 Unknown command 兜底。
    const unmanaged = await fail(['whoami'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    const payload = JSON.parse(unmanaged.stderr)
    expect(payload).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    expect(payload.error.message).not.toContain('Unknown command')
    // 参数校验也证明分发到位：whoami 无参，多给一个会走到它自己的校验错误，而非 Unknown command。
    const extra = await fail(['whoami', 'extra'], { AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: 'agent-self' })
    expect(JSON.parse(extra.stderr)).toMatchObject({
      error: { code: 'INVALID_CLI_ARGUMENT', message: 'whoami takes no arguments.' }
    })
  })
})
