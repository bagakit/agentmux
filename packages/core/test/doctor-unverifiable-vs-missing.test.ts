import { describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxClient } from '../src/client.js'
import { AgentMuxClient as RealClient } from '../src/client.js'
import { diagnoseAgentMux } from '../src/doctor.js'
import type { AgentMuxRuntimeDiagnostics } from '../src/types.js'

/**
 * 守「诊断分得清『查不成』与『没装』」。
 *
 * 缺陷（实测复现，非推理）：`probeAgent().installed` 是个 boolean，而 `classifyExecutable` 是三态。
 * 相对命令名 + 空 PATH ⇒ 一个候选都算不出 ⇒ `check-failed`，但 `hasExecutable` 把它折成 false，
 * 诊断于是报 `missing` + 「Install codex on this Host」。我在同一个退化环境里同时调两条路，打印出
 * `THREESTATE=check-failed INSTALLED=false`——同一个输入，两条路给出不同精度的答案，诊断取了差的那条。
 *
 * 为什么这条最该修：用户跑 doctor 就是因为 Agent 起不来、想知道病因。这时告诉他「没装，去装一个」
 * 会把他送去追一个不存在的安装问题，而真正的病因是 shell 环境没加载全（memory
 * login-shell-fallback-drops-zshrc-path 记的正是这个形状）。37e32665 在两处启动闸上修掉了同一句谎话，
 * 但 `installed` 有**三个**消费者，诊断面是漏掉的那个。
 *
 * 本文件刻意**不用替身**：`doctor.test.ts` 的 fake 直接喂 `installed:`，而缺陷恰恰住在
 * 「boolean 是从三态折下来的」这一步里——喂 boolean 的替身对它结构性失明（那份 fake 一直全绿）。
 * 所以这里跑真 client、真 classifyExecutable、真文件系统与真 PATH，用那次误报的真实输入形态。
 */

const runtime: AgentMuxRuntimeDiagnostics = {
  nodeVersion: '24.0.0',
  platform: 'darwin',
  arch: 'arm64',
  supported: true,
  ctxmux: {
    version: '0.1.0',
    protocolVersion: 12,
    sourceCommit: 'c13ab114f6ddf0cf8eb22c6cc39bb16f7aa0dec7',
    artifactPlatform: 'darwin-arm64',
    ready: true,
    capabilities: {
      transport: 'local-unix',
      orderedOutputBytes: true,
      boundedReplay: true,
      recoverableInput: true,
      resize: true,
      interrupt: true,
      completeStop: true
    }
  }
}

/**
 * 真 client 的真探测路径（`probeAgent` / `probeExecutorAvailability` 都不覆盖），只把 daemon 那半
 * 换成固定值——连接与 runtime 诊断不是被测对象，且不该让这条用例依赖本机有没有在跑 daemon。
 */
function clientWithRealProbes(): AgentMuxClient {
  const client = new RealClient()
  const internals = client as unknown as {
    connected: boolean
    kernel: { isConnected(): boolean }
  }
  internals.connected = true
  internals.kernel = { isConnected: () => true }
  const surface = client as unknown as Record<string, unknown>
  surface.connect = vi.fn(async () => {})
  surface.runtimeDiagnostics = vi.fn(async () => runtime)
  surface.endpointReclaim = () => null
  surface.runtimeIdentity = () => ({
    hostId: 'local',
    buildIdentity: 'ctxmux-fixture',
    protocolVersion: 12,
    processId: null,
    instanceId: 'daemon-fixture'
  })
  surface.dispose = vi.fn(async () => {})
  return client
}

async function codexReport(): Promise<{ probe: string; action: string | null }> {
  const report = await diagnoseAgentMux({ client: clientWithRealProbes() })
  const codex = report.agents.find((agent) => agent.id === 'codex')!
  return { probe: codex.probe, action: codex.action }
}

describe('doctor 区分「查不成」与「没装」', () => {
  it('PATH 退化、一个候选都算不出 → 说查不成并指向环境，绝不说没装', async () => {
    const previousPath = process.env.PATH
    // 相对命令名（codex 的 catalog executable）+ 空 PATH = 那次误报的真实输入形态。
    process.env.PATH = ''
    try {
      const { probe, action } = await codexReport()
      // 承重的一半：不能再谎称没装。把 doctor.ts 折回 `capability.installed ? 'found' : 'missing'`，
      // 这条红。
      expect(probe, 'doctor 把「查不成」报成了「没装」').toBe('unverifiable')
      // 另一半：说出来的话要真的指向环境，而不是换一句同样把人送去装东西的措辞。
      expect(action).toMatch(/could not verify/i)
      expect(action).toMatch(/PATH/)
      expect(action, '仍在让用户去装一个其实可能已经装了的东西').not.toMatch(/^Install /)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('查成了、确实没装 → 照旧说没装（新状态没有吃掉旧状态）', async () => {
    const previousPath = process.env.PATH
    // 绝对路径候选存在但指向空目录 ⇒ 查成了，确实没装。判据不能宽到把这一档也说成「查不成」。
    process.env.PATH = '/nonexistent-agentmux-doctor-probe'
    try {
      const { probe, action } = await codexReport()
      expect(probe, '真的没装却报成了查不成——判据过宽').toBe('missing')
      expect(action).toMatch(/^Install /)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})
