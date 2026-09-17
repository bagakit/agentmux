import type { AgentMuxClient } from './client.js'
import { runtimeStorageUsage, type RuntimeStorageUsage } from './runtime-storage-usage.js'
import type { AgentProviderId, AgentCapabilities, AgentCatalogEntry } from './types.js'

/**
 * 探测结果的四态。
 *
 * `'unverifiable'` 与 `'missing'` 必须分开：前者是「我们没查成」（环境退化，比如相对命令名 + 空
 * PATH——一个候选都算不出），后者是「查成了，确实没装」。折成一个 boolean 会让诊断当着用户的面
 * 说「没装，去装一个」，而真正的病因是 shell 环境没加载全，于是用户去追一个不存在的安装问题。
 * 这正是 37e32665 在启动闸上修掉的那次误报——诊断面是它漏掉的第三个消费者。
 */
export type AgentMuxDoctorProbeState = 'found' | 'missing' | 'unverifiable' | 'blocked'

export type AgentMuxDoctorAgent = {
  id: AgentProviderId
  label: string
  executable: string
  probe: AgentMuxDoctorProbeState
  action: string | null
  capabilities: AgentCapabilities
  hook: AgentCatalogEntry['hookStrategy']
  hookInstallation: Awaited<ReturnType<AgentMuxClient['inspectManagedHooks']>> & { phase: 'pre-connect' }
  permission: AgentCapabilities['permission']
  acp: AgentCatalogEntry['acpStrategy']
}

export type AgentMuxDoctorReport = {
  ok: boolean
  host: {
    kind: 'local'
    reachable: boolean
    hostId: string | null
    buildIdentity: string | null
    protocolVersion: number | null
    runtimeInstanceId: string | null
    error: string | null
    action: string | null
  }
  runtime: Awaited<ReturnType<AgentMuxClient['runtimeDiagnostics']>> | null
  runtimeAction: string | null
  /** Read-only disk observation of the selected Runtime, independent of host availability. */
  runtimeStorage: RuntimeStorageUsage | null
  runtimeStorageUnavailable: string | null
  hosts: {
    local: {
      status: 'available' | 'unavailable'
      action: string | null
    }
    remote: {
      status: 'unsupported'
      action: string
    }
  }
  agents: AgentMuxDoctorAgent[]
  /**
   * 全局层面上、**不随 provider 变化**的一组事实。只允许放真的全局事实，不放"每家各不相同的
   * 字段的平均值/默认值/汇总"——那一族真值一定属于 `agents[]`。
   *
   * 这里曾经塞过四条字面量：`hookInstallation`、`hookIngress`、`permissionDefault`、
   * `semanticEvidence`。其中三条实际是**逐-provider 事实**——每家 provider 各不相同：
   *
   * - `hookInstallation` 对 kimi 该是 `unmanaged`、traex 该是 `none`，全局字面量 `'explicit-managed'`
   *   对 13 家一律这么说，报反了两家（已在 b2bc7f1e 删）；
   * - `permissionDefault: 'reject'` 说的是"全局 permission 默认拒绝"，但今天**没有任何 provider
   *   声明 permission=reject**。真值在 `catalog.capabilities.permission` 上——traex=none、
   *   claude/codex=respond、pi=none、其余多数=observe。这个字面量是从没落地过的承诺；
   * - `semanticEvidence: 'native-hook-or-acp-only'` 里的 `-or-acp` 部分从没接通：今天所有
   *   provider 的 `acpStrategy` 都是 `{kind: 'none'}`，那条通路一端还没有。实际证据就是
   *   `native-hook`，"or-acp" 部分是承诺不是事实。
   *
   * 这三条冒充逐-provider 事实的字面量已全部删除。逐家的真值权威由 `agents[]` 承载：hook 归属
   * 看 `agents[].hook`（该 catalog 的 `hookStrategy`，SSOT 是 `providers/shared.ts` 的
   * `HOOK_INSTALLATION_BY_PROVIDER`），permission 看 `agents[].permission`，acp 通路看
   * `agents[].acp`。若哪天需要"聚合安装态"这种视图，另建 axis，别再往这个已经被弄脏的坑里
   * 加第二份聚合。
   *
   * 剩下的 `hookIngress` 是真的全局事实——AgentMux 只接受 authenticated loopback 上的 hook
   * 写入（见 `agent-hook-command.ts` 的 200-201 行与整个 hook 面的 owner-token 契约）。
   */
  integration: {
    hookIngress: 'authenticated-loopback'
  }
}

export type DiagnoseAgentMuxOptions = {
  client: AgentMuxClient
  commandOverrides?: Readonly<Record<string, string>>
  workspacePath?: string
  env?: Readonly<Record<string, string>>
}

function blockedAgent(catalog: AgentCatalogEntry, hookInstallation: AgentMuxDoctorAgent['hookInstallation']): AgentMuxDoctorAgent {
  return {
    id: catalog.id,
    label: catalog.label,
    executable: catalog.executable,
    probe: 'blocked',
    action: 'Restore the Runtime connection, then rerun doctor.',
    capabilities: { ...catalog.capabilities },
    hook: { ...catalog.hookStrategy },
    hookInstallation,
    permission: catalog.capabilities.permission,
    acp: { ...catalog.acpStrategy }
  }
}

async function probeAgent(
  client: AgentMuxClient,
  catalog: AgentCatalogEntry,
  commandOverride: string | undefined,
  hookInstallation: AgentMuxDoctorAgent['hookInstallation']
): Promise<AgentMuxDoctorAgent> {
  try {
    const capability = await client.probeAgent(catalog.id, commandOverride)
    // 三态探测问的是同一个 Executor 的同一件事，但它区分「查不成」与「没装」，而 `capability.installed`
    // 把两者折成 false。诊断恰恰是最不能折的地方：用户来这里就是为了知道病因。两次探测共用
    // probeCapabilities 里那一份命令解析（commandOverride 优先，否则 catalog executable），所以它们
    // 看的一定是同一条命令，不会各自解析出不同的东西。
    const availability = await client.probeExecutorAvailability(catalog.id, commandOverride)
    const probe = availability === 'available'
      ? 'found'
      : availability === 'check-failed' ? 'unverifiable' : 'missing'
    return {
      id: catalog.id,
      label: catalog.label,
      executable: capability.executable,
      probe,
      action: probe === 'found'
        ? null
        : probe === 'unverifiable'
          // 指向环境，不是指向安装。这句话与启动闸拒绝时说的是同一件事，措辞也应当同源地读起来一致。
          ? `Could not verify ${catalog.label} on this Host: no candidate path to probe. Check PATH and your shell environment, then rerun doctor.`
          : `Install ${catalog.label} on this Host or configure an explicit executable.`,
      capabilities: { ...capability.capabilities },
      hook: { ...catalog.hookStrategy },
      hookInstallation,
      permission: catalog.capabilities.permission,
      acp: { ...catalog.acpStrategy }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ...blockedAgent(catalog, hookInstallation),
      action: `Fix the ${catalog.label} executable probe, then rerun doctor: ${detail}`
    }
  }
}

export async function diagnoseAgentMux(options: DiagnoseAgentMuxOptions): Promise<AgentMuxDoctorReport> {
  const catalog = options.client.catalog()
  const hookInstallations = await Promise.all(catalog.map(async entry => ({
    ...await options.client.inspectManagedHooks(entry.id, {
      ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.commandOverrides?.[entry.id] === undefined ? {} : { command: options.commandOverrides[entry.id] })
    }), phase: 'pre-connect' as const
  })))
  const observeStorage = () => runtimeStorageUsage().then(
    (runtimeStorage) => ({ runtimeStorage, runtimeStorageUnavailable: null }),
    (error: unknown) => ({
      runtimeStorage: null,
      runtimeStorageUnavailable: error instanceof Error ? error.message : String(error)
    })
  )
  try {
    await options.client.connect()
    const identity = options.client.runtimeIdentity()
    const [runtime, agents] = await Promise.all([
      options.client.runtimeDiagnostics(),
      Promise.all(catalog.map(async (entry, index) => await probeAgent(
        options.client,
        entry,
        options.commandOverrides?.[entry.id], hookInstallations[index]!
      )))
    ])
    return {
      ok: runtime.supported && runtime.ctxmux.ready && agents.every((agent) => agent.probe !== 'blocked'),
      host: {
        kind: 'local',
        reachable: true,
        hostId: identity.hostId,
        buildIdentity: identity.buildIdentity,
        protocolVersion: identity.protocolVersion,
        runtimeInstanceId: identity.instanceId,
        error: null,
        action: null
      },
      runtime,
      ...await observeStorage(),
      runtimeAction: !runtime.supported
        ? 'Use Node 24 or newer on macOS arm64 with the bundled darwin-arm64 ctxmux artifacts.'
        : !runtime.ctxmux.ready
          ? 'Reinstall @agentmux/core and verify the pinned ctxmux artifact manifest.'
          : null,
      hosts: {
        local: {
          status: runtime.supported && runtime.ctxmux.ready ? 'available' : 'unavailable',
          action: runtime.supported && runtime.ctxmux.ready
            ? null
            : 'Restore the pinned local ctxmux runtime, then rerun doctor.'
        },
        remote: {
          status: 'unsupported',
          action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
        }
      },
      agents,
      integration: {
        hookIngress: 'authenticated-loopback'
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      host: {
        kind: 'local',
        reachable: false,
        hostId: null,
        buildIdentity: null,
        protocolVersion: null,
        runtimeInstanceId: null,
        error: detail,
        action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
      },
      runtime: null,
      ...await observeStorage(),
      runtimeAction: null,
      hosts: {
        local: {
          status: 'unavailable',
          action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
        },
        remote: {
          status: 'unsupported',
          action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
        }
      },
      agents: catalog.map((entry, index) => blockedAgent(entry, hookInstallations[index]!)),
      integration: {
        hookIngress: 'authenticated-loopback'
      }
    }
  }
}
