import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxClient } from '../src/client.js'
import { diagnoseAgentMux } from '../src/doctor.js'
import type { AgentProviderId, AgentMuxRuntimeDiagnostics } from '../src/types.js'

const runtime: AgentMuxRuntimeDiagnostics = {
  nodeVersion: '24.0.0',
  platform: 'darwin',
  arch: 'arm64',
  supported: true,
  ctxmux: {
    version: '0.1.0',
    protocolVersion: 12,
    sourceCommit: '073e206407ce28331aa882c2c80e9354cfe2879a',
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
    connect: vi.fn(async () => {}),
    runtimeIdentity: () => ({
      hostId: 'local',
      buildIdentity: 'ctxmux-fixture',
      protocolVersion: 12,
      processId: null,
      instanceId: 'daemon-fixture'
    }),
    runtimeDiagnostics: vi.fn(async () => runtime),
    endpointReclaim: () => null,
    probeAgent: vi.fn(async (providerId: AgentProviderId) => ({
      providerId,
      executable: catalog.find((entry) => entry.id === providerId)!.executable,
      installed: providerId === 'codex',
      capabilities: catalog.find((entry) => entry.id === providerId)!.capabilities
    })),
    ...overrides
  } as unknown as AgentMuxClient
}

const UID = typeof process.getuid === 'function' ? process.getuid() : 0

afterEach(() => { delete process.env.AGENTMUX_RUNTIME_DIRECTORY })

describe('AgentMux doctor', () => {
  // 「让 endpoint 占用可见」这条只有真的算出体积才算数。把 runtime 目录指到一棵自造的树上，
  // 断言报告里报出了那个已知字节数——若 endpointStorage 退化成空表或写死的 []，这条立刻变红。
  it('reports real endpoint storage usage, not an empty placeholder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-doctor-'))
    const current = join(root, `amx-${UID}-${'a'.repeat(24)}`)
    await mkdir(current, { recursive: true })
    await writeFile(join(current, 'state.sqlite3'), 'x'.repeat(2048))
    process.env.AGENTMUX_RUNTIME_DIRECTORY = current

    const report = await diagnoseAgentMux({ client: client() })

    expect(report.endpointStorage).toEqual([{ path: current, bytes: 2048, current: true }])
    await rm(root, { recursive: true, force: true })
  })

  // 回收失败若无处可看，「不阻断启动、只留可诊断信息」就只剩前半句：每次启动都删不掉的目录会一直
  // 无声堆着。这条把回收结果真的从 client 端穿到报告里——把 `endpointReclaim` 写死成 null 会变红。
  it('carries the startup reclamation outcome, failures included', async () => {
    const outcome = {
      reclaimed: ['/private/tmp/amx-501-aaaaaaaaaaaaaaaaaaaaaaaa'],
      skippedLive: [],
      failed: [{ path: '/private/tmp/amx-501-bbbbbbbbbbbbbbbbbbbbbbbb', reason: 'EACCES: permission denied' }]
    }

    const report = await diagnoseAgentMux({ client: client({ endpointReclaim: () => outcome }) })

    expect(report.endpointReclaim).toEqual(outcome)
  })

  // 没连上运行时就没跑过回收。这时必须是 null——空 outcome 会被读成「回收跑过且一切正常」。
  it('reports no reclamation at all when the runtime is unreachable', async () => {
    const report = await diagnoseAgentMux({
      client: client({ connect: vi.fn(async () => { throw new Error('owner receipt mismatch') }) })
    })

    expect(report.endpointReclaim).toBeNull()
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
    expect(report.integration).toEqual({
      hookIngress: 'authenticated-loopback',
      hookInstallation: 'explicit-managed',
      permissionDefault: 'reject',
      semanticEvidence: 'native-hook-or-acp-only'
    })
    expect(report.agents.find((agent) => agent.id === 'codex')).toMatchObject({
      probe: 'found',
      hook: { kind: 'native' },
      permission: 'respond',
      acp: { kind: 'none' }
    })
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
    expect(report.agents.every((agent) => agent.probe === 'blocked')).toBe(true)
  })
})
