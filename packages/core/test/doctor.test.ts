import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxClient } from '../src/client.js'
import { diagnoseAgentMux } from '../src/doctor.js'
import { HOOK_INSTALLATION_BY_PROVIDER } from '../src/providers/shared.js'
import type { AgentProviderId, AgentMuxRuntimeDiagnostics, AgentHookStrategy } from '../src/types.js'

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

function client(overrides: Partial<AgentMuxClient> = {}): AgentMuxClient {
  const catalog = new AgentProviderRegistry().catalog()
  return {
    catalog: () => catalog,
    inspectManagedHooks: vi.fn(async (providerId: AgentProviderId) => ({ providerId, workspacePath: null, checkedAt: Date.now(), status: 'skipped', code: 'HOOK_WORKSPACE_REQUIRED', action: 'Provide the exact workspace.', targets: [] })),
    connect: vi.fn(async () => {}),
    runtimeIdentity: () => ({
      hostId: 'local',
      buildIdentity: 'ctxmux-fixture',
      protocolVersion: 12,
      processId: null,
      instanceId: 'daemon-fixture'
    }),
    runtimeDiagnostics: vi.fn(async () => runtime),
    probeAgent: vi.fn(async (providerId: AgentProviderId) => ({
      providerId,
      executable: catalog.find((entry) => entry.id === providerId)!.executable,
      installed: providerId === 'codex',
      capabilities: catalog.find((entry) => entry.id === providerId)!.capabilities
    })),
    // 诊断的探测状态由这条三态探测决定，不再由 `probeAgent().installed` 决定——后者把「查不成」
    // 折进「没装」。默认替身与上面的 `installed` 保持一致（codex 装了，其余没装），这样既有断言
    // 不变；「查不成」那一档由需要它的用例自己 override。
    probeExecutorAvailability: vi.fn(async (providerId: AgentProviderId) =>
      providerId === 'codex' ? 'available' : 'missing'),
    ...overrides
  } as unknown as AgentMuxClient
}

const UID = typeof process.getuid === 'function' ? process.getuid() : 0

afterEach(() => { delete process.env.AGENTMUX_RUNTIME_DIRECTORY })

describe('AgentMux doctor', () => {
  it('reports real selected Runtime storage without including sibling directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-doctor-'))
    const current = join(root, 'selected-runtime')
    try {
      await mkdir(current)
      await mkdir(join(root, `amx-${UID}-${'a'.repeat(24)}`))
      await writeFile(join(root, `amx-${UID}-${'a'.repeat(24)}`, 'old-state'), 'x'.repeat(4096))
      await writeFile(join(current, 'state.sqlite3'), 'x'.repeat(2048))
      process.env.AGENTMUX_RUNTIME_DIRECTORY = current
      const report = await diagnoseAgentMux({ client: client() })
      expect(report.runtimeStorage).toEqual({ path: current, bytes: 2048 })
      expect(report.runtimeStorageUnavailable).toBeNull()
      expect(report.ok).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('shows the disk failure without changing a healthy Runtime into blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-doctor-'))
    try {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'missing')
      const report = await diagnoseAgentMux({ client: client() })
      expect(report.runtimeStorage).toBeNull()
      expect(report.runtimeStorageUnavailable).toContain('ENOENT')
      expect(report.ok).toBe(true)
      expect(report.host.reachable).toBe(true)
      expect(report.agents.find((agent) => agent.id === 'codex')?.probe).toBe('found')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps disk observation distinct from an unavailable Runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-doctor-'))
    try {
      await writeFile(join(root, 'state.sqlite3'), 'x'.repeat(1024))
      process.env.AGENTMUX_RUNTIME_DIRECTORY = root
      const report = await diagnoseAgentMux({
        client: client({ connect: vi.fn(async () => { throw new Error('owner receipt mismatch') }) })
      })
      expect(report.runtimeStorage).toEqual({ path: root, bytes: 1024 })
      expect(report.runtimeStorageUnavailable).toBeNull()
      expect(report.host.error).toBe('owner receipt mismatch')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reports the exact ctxmux capability, integration, permission, and Host boundaries', async () => {
    const report = await diagnoseAgentMux({ client: client() })

    expect(report.ok).toBe(true)
    expect(report.runtime?.ctxmux).toMatchObject({
      protocolVersion: 12,
      artifactPlatform: 'darwin-arm64',
      capabilities: {
        transport: 'local-unix',
        boundedReplay: true,
        recoverableInput: true,
        interrupt: true,
        completeStop: true
      }
    })
    expect(report.hosts).toEqual({
      local: { status: 'available', action: null },
      remote: {
        status: 'unsupported',
        action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
      }
    })
    // integration 只允许放**真的全局事实**——不随 provider 变化的那一类。逐-provider 事实
    // （hook 归属、permission 默认、semantic 证据来源）曾在这里以字面量冒充普适事实，全部已删。
    // toEqual 精确匹配，任何字段被加回来都会当场红——比列一份名字禁令强，也不会随字面量拼法漂移。
    expect(report.integration).toEqual({
      hookIngress: 'authenticated-loopback'
    })
    expect(report.agents.find((agent) => agent.id === 'codex')).toMatchObject({
      probe: 'found',
      hook: { kind: 'native' },
      permission: 'respond',
      acp: { kind: 'none' }
    })
  })

  /**
   * hook 安装归属是**逐 Provider 的事实**，doctor 报出来的必须逐家等于 SSOT，不能是一个全局常量。
   *
   * 这条守的是一个被删掉的缺陷：`integration` 块里曾写死 `hookInstallation: 'explicit-managed'`，
   * 对 13 家一律这么说——而 kimi 真实是 `unmanaged`、traex 是 `none`（连 hook 都没有）。那个字段没有
   * 任何生产消费者，是一份会说谎的重复事实，已删。逐家的真值改由 `agents[].hook`（该 catalog 的
   * `hookStrategy`）承载，本条把「doctor 报的 == HOOK_INSTALLATION_BY_PROVIDER 那家的值」逐 id 钉死。
   *
   * 判据必须逐家遍历、且钉死**整张映射**（`toEqual`），不能抽查：只查 codex 会让 kimi/traex 两个例外
   * 继续裸奔，而它们正是原缺陷报反的两家。把 doctor 里 `hook: { ...catalog.hookStrategy }` 变异成写死
   * `{ kind: 'native', installation: 'explicit-managed' }`，本条会同时因 kimi 和 traex 变红。
   *
   * 这与 provider-conformance 里那条不同：那条钉的是「SSOT 表 == catalog」，本条钉的是「doctor 报出来的
   * == SSOT 表」——两处投影各守一段，doctor 这一段此前无人守（旧断言抄的是被测对象唯一可能的字面量，恒真）。
   */
  it('reports each provider hook-installation as its own fact, matching the SSOT for all providers', async () => {
    const report = await diagnoseAgentMux({ client: client() })
    const classify = (hook: AgentHookStrategy) =>
      hook.kind === 'none' ? 'none' : hook.installation
    const reported = Object.fromEntries(
      report.agents.map((agent) => [agent.id, classify(agent.hook)])
    )
    // 自检：doctor 真的报了全部 13 家，否则下面那条 toEqual 在比两张都缺 kimi/traex 的空表，恒真。
    expect(Object.keys(reported).sort()).toEqual(
      Object.keys(HOOK_INSTALLATION_BY_PROVIDER).sort()
    )
    expect(reported).toEqual({ ...HOOK_INSTALLATION_BY_PROVIDER })
    // 点名两个例外：它们是原缺陷报反/报错字段的两家，必须真的以非 explicit-managed 出现在报告里。
    expect(reported.kimi).toBe('unmanaged')
    expect(reported.traex).toBe('none')
  })

  it('does not advertise unsupported platforms or Remote as usable', async () => {
    const unsupported: AgentMuxRuntimeDiagnostics = {
      ...runtime,
      platform: 'linux',
      arch: 'x64',
      supported: false
    }
    const report = await diagnoseAgentMux({
      client: client({ runtimeDiagnostics: vi.fn(async () => unsupported) })
    })

    expect(report.ok).toBe(false)
    expect(report.runtimeAction).toContain('macOS arm64')
    expect(report.runtimeAction).not.toContain('Linux')
    expect(report.hosts.local.status).toBe('unavailable')
    expect(report.hosts.remote).toEqual({
      status: 'unsupported',
      action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
    })
  })

  it('turns an unreachable runtime into actionable blocked diagnostics', async () => {
    const report = await diagnoseAgentMux({
      client: client({ connect: vi.fn(async () => { throw new Error('owner receipt mismatch') }) })
    })

    // Runtime failure cannot change a Provider's installation policy into a shared default.
    const policies = Object.fromEntries(report.agents.map((agent) => [
      agent.id, agent.hook.kind === 'none' ? 'none' : agent.hook.installation
    ]))
    expect(Object.keys(policies).sort()).toEqual(Object.keys(HOOK_INSTALLATION_BY_PROVIDER).sort())
    expect(policies).toEqual({ ...HOOK_INSTALLATION_BY_PROVIDER })
    expect(policies.kimi).toBe('unmanaged')
    expect(policies.traex).toBe('none')

    expect(report).toMatchObject({
      ok: false,
      host: {
        reachable: false,
        error: 'owner receipt mismatch',
        action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
      },
      runtime: null,
      hosts: {
        local: { status: 'unavailable' },
        remote: {
          status: 'unsupported',
          action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
        }
      }
    })
    // `report.agents` 空了的话，下面那条 `every` 照样绿——而「doctor 一个 agent 都没报」
    // 比「某个 agent 没被标 blocked」严重得多。拿 catalog 的规模钉一次长度：doctor 在 host
    // 不可达时是 `catalog.map(blockedAgent)`，少一个、或者整个空掉，这里当场红。不写死 13：
    // 那会让每次新增 Provider 都打红这条，而它并不关心 Provider 有几个，只关心一个都没漏。
    expect(report.agents, 'doctor 漏报了 catalog 里的 agent').toHaveLength(
      new AgentProviderRegistry().catalog().length
    )
    expect(report.agents.every((agent) => agent.probe === 'blocked')).toBe(true)
    // 失败路径的 integration 形状必须与成功路径一致——否则清理只在成功路径生效、失败路径继续说谎。
    // 这一族缺陷的历史标记正是「成功路径与失败路径给出完全一样的字面量」；反过来清理也必须两处
    // 同步。上面那条 `toMatchObject` 对多余字段宽容，不足以钉住这一点，专门用 `toEqual` 定死一次。
    expect(report.integration).toEqual({
      hookIngress: 'authenticated-loopback'
    })
  })
})
