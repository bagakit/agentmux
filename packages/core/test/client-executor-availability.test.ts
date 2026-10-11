import { fixturePath } from './helpers/fixture-values.js'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'

const faults = vi.hoisted(() => new Map<string, { operation: 'stat' | 'access'; code: string; message: string }>())
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  function fault(path: unknown, operation: 'stat' | 'access') {
    const input = faults.get(String(path))
    if (input?.operation === operation) throw Object.assign(new Error(input.message), { code: input.code })
  }
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => { fault(args[0], 'stat'); return await actual.stat(...args) },
    access: async (...args: Parameters<typeof actual.access>) => { fault(args[0], 'access'); return await actual.access(...args) }
  }
})

// probeExecutorAvailability 的三态判据，跑**真的** classifyExecutable（走真文件系统与真 PATH 解析），
// 不是 mock。要害在于把两件被 boolean `installed` 折在一起的事分开：
//   - check-failed：命令是相对名、PATH 又是空的 → 一个候选都算不出 → 我们没查成（环境退化）。
//   - missing：配置的可执行文件未找到，不能推断软件未安装。
//   - available：解析到的路径上有可执行文件。
// 发现保留三态；准确命令的检查失败不封闭原 Native 执行，真实执行反例另见 executable-launch-context。

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  faults.clear()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

// Executable observation is available with no Runtime connection. Launch fixtures alone
// provide a controlled connection, stopping before Hook/Runtime work.
function probeClient(): AgentMuxClient {
  return new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
}
function connectedClient(): AgentMuxClient {
  const client = probeClient()
  const internals = client as unknown as { connected: boolean; kernel: { isConnected(): boolean }; requireHookIngressOwner(): Promise<void> }
  internals.connected = true
  internals.kernel = { isConnected: () => true }
  internals.requireHookIngressOwner = vi.fn(async () => { throw new Error('Owned probe fixture stops before Hook or Runtime setup') })
  return client
}

describe('AgentMuxClient.probeExecutorAvailability', () => {
  it('keeps paths with spaces literal and diagnoses a whole command line without splitting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-spaced-executable-')); roots.push(root)
    const bin = join(root, 'wrapper with spaces')
    await writeFile(bin, '#!/bin/sh\n'); await chmod(bin, 0o755)
    const client = probeClient()
    expect(await client.probeExecutorAvailability('codex', bin)).toEqual({ executable: bin, availability: 'available' })
    const commandLine = bin + ' --model "literal model"'
    const missing = await client.probeExecutorAvailability('codex', commandLine)
    expect(missing).toMatchObject({ availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FOUND' } })
    expect(missing.cause!.message).toContain(JSON.stringify(commandLine))
    expect(missing.cause!.message).toContain('args')
    expect(missing.cause!.message).not.toContain('not installed')
  })

  it('reports available when the resolved command is executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-avail-'))
    roots.push(root)
    const bin = join(root, 'codex')
    await writeFile(bin, '#!/bin/sh\n')
    await chmod(bin, 0o755)
    // commandOverride 是绝对路径 → 只有这一条候选，且它可执行。
    const client = probeClient()
    await expect(client.probeExecutorAvailability('codex', bin)).resolves.toEqual({ executable: bin, availability: 'available' })
    expect((await client.probeAgent('codex', bin)).installed).toBe(true)
  })

  it('reports the exact configured executable when lookup finds no file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-missing-'))
    roots.push(root)
    // 绝对路径（含 '/'）→ 候选非空，但文件不存在 → 只确认配置文件不存在。
    await expect(probeClient().probeExecutorAvailability('codex', join(root, 'does-not-exist')))
      .resolves.toMatchObject({ executable: join(root, 'does-not-exist'), availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FOUND', message: expect.stringContaining(JSON.stringify(join(root, 'does-not-exist'))) } })
  })

  it('reports check-failed when a relative command has no PATH candidates to probe', async () => {
    const previousPath = process.env.PATH
    // 相对命令 + 空 PATH → 零候选 → 环境退化，我们没查成。绝不能报 missing。
    process.env.PATH = ''
    try {
      // commandOverride 留空 → 用 Provider 的 catalog executable（codex 的是相对名 'codex'）。
      const outcome = await probeClient().probeExecutorAvailability('codex')
      // 单钉这条：零候选必须报 check-failed。把 client.ts 里 `candidates.length === 0` 那支折成
      // 'missing'（或删掉），这条红——那正是那次误报的形态。
      expect(outcome).toEqual({ executable: 'codex', availability: 'check-failed', cause: {
        code: 'EXECUTABLE_SEARCH_UNAVAILABLE',
        message: 'No candidate path was searchable for "codex". Check PATH and the shell environment this app was launched from.'
      } })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('rejects a searchable directory while keeping an executable file and its symlink available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-kind-')); roots.push(root)
    const bin = join(root, 'executable'), link = join(root, 'linked-executable')
    await writeFile(bin, '#!/bin/sh\n'); await chmod(bin, 0o755); await symlink(bin, link)
    const client = probeClient()
    await expect(client.probeExecutorAvailability('codex', root)).resolves.toEqual({ executable: root, availability: 'missing', cause: {
      code: 'EXECUTABLE_NOT_FILE', message: `${root} is a directory; expected a regular executable file.`
    } })
    await expect(client.probeExecutorAvailability('codex', bin)).resolves.toEqual({ executable: bin, availability: 'available' })
    await expect(client.probeExecutorAvailability('codex', link)).resolves.toEqual({ executable: link, availability: 'available' })
  })

  it('preserves unknown stat and access causes instead of claiming an executable is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-read-')); roots.push(root)
    const bin = join(root, 'executable'); await writeFile(bin, '#!/bin/sh\n'); await chmod(bin, 0o755)
    faults.set(bin, { operation: 'stat', code: 'EIO', message: 'controlled stat I/O failure' })
    await expect(probeClient().probeExecutorAvailability('codex', bin)).resolves.toEqual({ executable: bin, availability: 'check-failed', cause: { code: 'EIO', message: 'controlled stat I/O failure' } })
    faults.set(bin, { operation: 'access', code: 'EACCES', message: 'controlled execute access denial' })
    await expect(probeClient().probeExecutorAvailability('codex', bin)).resolves.toEqual({ executable: bin, availability: 'check-failed', cause: { code: 'EACCES', message: 'controlled execute access denial' } })
  })

  it('prefers a later ordinary executable over a directory or unknown earlier candidate, preserving unknown when none succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-path-')); roots.push(root)
    const first = join(root, 'first'), second = join(root, 'second')
    await mkdir(join(first, 'probe-command'), { recursive: true }); await mkdir(second)
    const bin = join(second, 'probe-command'); await writeFile(bin, '#!/bin/sh\n'); await chmod(bin, 0o755)
    vi.stubEnv('PATH', `${first}:${second}`)
    const client = probeClient()
    await expect(client.probeExecutorAvailability('codex', 'probe-command')).resolves.toEqual({ executable: 'probe-command', availability: 'available' })
    faults.set(join(first, 'probe-command'), { operation: 'stat', code: 'EIO', message: 'controlled first candidate failure' })
    await expect(client.probeExecutorAvailability('codex', 'probe-command')).resolves.toEqual({ executable: 'probe-command', availability: 'available' })
    await rm(bin)
    await expect(client.probeExecutorAvailability('codex', 'probe-command')).resolves.toEqual({ executable: 'probe-command', availability: 'check-failed', cause: { code: 'EIO', message: 'controlled first candidate failure' } })
    faults.clear()
    await expect(client.probeExecutorAvailability('codex', 'probe-command')).resolves.toEqual({ executable: 'probe-command', availability: 'missing', cause: {
      code: 'EXECUTABLE_NOT_FILE', message: `${join(first, 'probe-command')} is a directory; expected a regular executable file.`
    } })
  })
})

/**
 * 闸门侧的另一半。上面那组钉的是**发现**面（probeExecutorAvailability 三态齐全），而误报发生在
 * **启动/resume** 面：那两处此前各写一句逐字相同的「not installed on this host」，把 check-failed
 * 也说成没装。准确文件缺失仍拒绝，检查失败继续原启动；本组核对理由与原流程入口。
 *
 * 为什么判 message 而不是 error code：Electron 的 `ipcRenderer.invoke` 丢掉 `.code`/`.detail`，只把
 * message 送到渲染端，所以 message 就是用户能看到的全部。判 code 会在这条路上全程恒真。
 */
describe('启动闸拒绝时的理由：查不成 ≠ 没装', () => {
  /** 让 createAgent 走到闸门那一步就好——闸门在方法极早处，后面的 kernel 交互到不了。 */
  async function launchError(commandOverride: string): Promise<Error> {
    try {
      await connectedClient().createAgent({
        providerId: 'codex',
        workspacePath: fixturePath('temporary'),
        prompt: 'hi',
        commandOverride
      } as never)
    } catch (error) {
      return error as Error
    }
    throw new Error('createAgent 没有抛错——闸门没拦住，这条用例失去意义')
  }

  it('a missing configured file does not claim that software is not installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-gate-missing-'))
    roots.push(root)
    // 绝对路径 → 候选非空 → 文件不在 → missing，不证明软件未安装。
    const error = await launchError(join(root, 'does-not-exist'))
    expect(error.message).toContain('Configured executable')
    expect(error.message).toContain(JSON.stringify(join(root, 'does-not-exist')))
    expect(error.message).toContain('args')
    expect(error.message).not.toContain('not installed')
  })

  it('checks the managed launch PATH even when the inherited PATH is empty', async () => {
    const previousPath = process.env.PATH
    process.env.PATH = ''
    try {
      // Actual launch still supplies its managed CLI directory. This is a confirmed
      // missing command in that PATH, while a context-free empty PATH stays unknown above.
      const error = await launchError('codex')
      expect(error.message).not.toContain('is not installed on this host')
      expect(error.message).toMatch(/Configured executable.*codex.*was not found/i)
      expect(error.message).toMatch(/PATH/)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('continues beyond a failed executable read while rejecting a confirmed directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-gate-cause-')); roots.push(root)
    const bin = join(root, 'executable'); await writeFile(bin, '#!/bin/sh\n'); await chmod(bin, 0o755)
    faults.set(bin, { operation: 'access', code: 'EIO', message: 'controlled launch verification failure' })
    const unknown = await launchError(bin)
    expect(unknown.message).toBe('Owned probe fixture stops before Hook or Runtime setup')
    expect(unknown.message).not.toMatch(/not installed|no candidate path|PATH/)
    const notFile = await launchError(root)
    expect(notFile.message).toContain('is a directory; expected a regular executable file')
    expect(notFile.message).not.toContain('not installed')
  })
})
