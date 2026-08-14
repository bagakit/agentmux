import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'

// probeExecutorAvailability 的三态判据，跑**真的** classifyExecutable（走真文件系统与真 PATH 解析），
// 不是 mock。要害在于把两件被 boolean `installed` 折在一起的事分开：
//   - check-failed：命令是相对名、PATH 又是空的 → 一个候选都算不出 → 我们没查成（环境退化）。
//   - missing：命令解析到了一条具体路径，但那条路径上没有可执行文件 → 查成了，确实没装。
//   - available：解析到的路径上有可执行文件。
// 这正是那次「PATH 退化被误报成 Not Installed」要防的分岔。启动闸仍是 `=== 'available'`，check-failed
// 一样拒绝启动，无回归——那条由 hasExecutable 保证，本文件只钉发现侧的三态区分。

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

// 造一个已连接的 client，只为让 requireConnected 放行——probeExecutorAvailability 不碰 kernel，
// 只解析命令再查文件系统。vitest 只转译不查类型，允许改私有面。
function connectedClient(): AgentMuxClient {
  const client = new AgentMuxClient()
  const internals = client as unknown as { connected: boolean; kernel: { isConnected(): boolean } }
  internals.connected = true
  internals.kernel = { isConnected: () => true }
  return client
}

describe('AgentMuxClient.probeExecutorAvailability', () => {
  it('reports available when the resolved command is executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-avail-'))
    roots.push(root)
    const bin = join(root, 'codex')
    await writeFile(bin, '#!/bin/sh\n')
    await chmod(bin, 0o755)
    // commandOverride 是绝对路径 → 只有这一条候选，且它可执行。
    await expect(connectedClient().probeExecutorAvailability('codex', bin)).resolves.toBe('available')
  })

  it('reports missing when the resolved command exists as a path but is not executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-missing-'))
    roots.push(root)
    // 绝对路径（含 '/'）→ 候选非空，但文件不存在 → 查成了，确实没装。
    await expect(connectedClient().probeExecutorAvailability('codex', join(root, 'does-not-exist')))
      .resolves.toBe('missing')
  })

  it('reports check-failed when a relative command has no PATH candidates to probe', async () => {
    const previousPath = process.env.PATH
    // 相对命令 + 空 PATH → 零候选 → 环境退化，我们没查成。绝不能报 missing。
    process.env.PATH = ''
    try {
      // commandOverride 留空 → 用 Provider 的 catalog executable（codex 的是相对名 'codex'）。
      const outcome = await connectedClient().probeExecutorAvailability('codex')
      // 单钉这条：零候选必须报 check-failed。把 client.ts 里 `candidates.length === 0` 那支折成
      // 'missing'（或删掉），这条红——那正是那次误报的形态。
      expect(outcome).toBe('check-failed')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})

/**
 * 闸门侧的另一半。上面那组钉的是**发现**面（probeExecutorAvailability 三态齐全），而误报发生在
 * **启动/resume** 面：那两处此前各写一句逐字相同的「not installed on this host」，把 check-failed
 * 也说成没装。闸门该不该拒绝不是本组要改的（非 available 一律拒绝，无回归）；本组钉的是**理由**。
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
        workspacePath: '/tmp',
        prompt: 'hi',
        commandOverride
      } as never)
    } catch (error) {
      return error as Error
    }
    throw new Error('createAgent 没有抛错——闸门没拦住，这条用例失去意义')
  }

  it('查成了、确实没装 → 照旧说「没装」', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-gate-missing-'))
    roots.push(root)
    // 绝对路径 → 候选非空 → 文件不在 → missing。
    const error = await launchError(join(root, 'does-not-exist'))
    expect(error.message).toContain('is not installed on this host')
  })

  it('PATH 退化、根本没查成 → 不许说「没装」，要说查不成并指向环境', async () => {
    const previousPath = process.env.PATH
    process.env.PATH = ''
    try {
      // 相对名 + 空 PATH → 零候选 → check-failed。这正是实战里那次误报的输入形态。
      const error = await launchError('codex')
      // 承重的一半：不能再谎称没装。把 executorUnavailableError 里的三态分支折掉（两支都返回
      // 「not installed」），这条红。
      expect(error.message).not.toContain('is not installed on this host')
      // 另一半：说出来的话要真的指向「我们没查成 + 去看环境」，而不是换一句同样无用的措辞。
      expect(error.message).toMatch(/could not verify/i)
      expect(error.message).toMatch(/PATH/)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})
