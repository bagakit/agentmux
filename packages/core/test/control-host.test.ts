import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxControlServer,
  parseAgentMuxControlReceipt,
  parseAgentMuxControlRequest,
  requestAgentMuxControl
} from '../src/control-host.js'
import {
  AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  agentMuxControlTimeoutMs,
  isLongAgentMuxControlOperation,
  resolveAgentMuxRegion,
  type AgentMuxAgentRegion,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxRegion
} from '../src/control.js'

const roots: string[] = []
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))))

const agentRegion: AgentMuxAgentRegion = {
  tabId: 'tab-main',
  regionId: 'agent-left',
  workspaceId: 'workspace',
  kind: 'agent',
  agentSessionId: 'semantic-1',
  providerId: 'codex',
  executorId: 'codex'
}
const regions: AgentMuxRegion[] = [agentRegion, {
  tabId: 'tab-main',
  regionId: 'browser-right',
  workspaceId: 'workspace',
  kind: 'browser',
  browserId: 'browser-1'
}]
const terminalRegion = {
  tabId: 'tab-main', regionId: 'terminal-bottom', workspaceId: 'workspace', kind: 'terminal', runId: 'run-terminal'
} as const
const browserRegion = {
  tabId: 'tab-main', regionId: 'browser-right', workspaceId: 'workspace', kind: 'browser', browserId: 'browser-1'
} as const
/** 只有一格、也只有一张 Tab 时的邻居：四个方向都到边。 */
const soleRegionNeighbors = {
  left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' }
} as const

describe('Control protocol', () => {
  it('uses only closed Tab, Region, AgentSession, Run, and owner surface identities', () => {
    expect(resolveAgentMuxRegion(regions, { kind: 'region', regionId: 'browser-right' })).toEqual(regions[1])
    expect(resolveAgentMuxRegion(regions, { kind: 'agent-session', agentSessionId: 'semantic-1' })).toEqual(agentRegion)
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'inspect',
      ok: true,
      operation: 'inspect.region',
      result: {
        region: {
          tabId: 'tab-main',
          regionId: 'unknown',
          workspaceId: 'workspace',
          kind: 'other',
          bounds: { x: 0, y: 0, width: 1, height: 1 }
        }
      }
    })).toThrow('Region result')
  })

  // resolveAgentMuxRegion has three error branches and NO negative-path test drove any of them: the
  // success-path assertions above only reach the final `return`. Each of the next three it()s pins one
  // branch, in its own it() so a mutation reddening one cannot be masked by another throwing first.
  // Both AMBIGUOUS_REGION_TARGET branches assert their DISTINCT message, because the shared code alone
  // cannot tell the duplicate-id guard apart from the multi-match guard.

  it('resolveAgentMuxRegion throws AMBIGUOUS_REGION_TARGET when two regions share a regionId', () => {
    // Kills: the duplicate-id guard condition replaced by `false && …` (guard never fires). With it off,
    // a target that uniquely matches a THIRD region resolves successfully instead of erroring on the
    // ambiguous set, so the assertion below (expecting a throw) reds. The message 'Open Region identity
    // is ambiguous.' distinguishes this guard from the multi-match branch's 'Region target is ambiguous.'
    const dupA = { ...agentRegion, regionId: 'dup', agentSessionId: 'session-a' }
    const dupB = { ...browserRegion, regionId: 'dup' }
    const unique = { ...terminalRegion, regionId: 'unique-region' }
    const ambiguousSet: AgentMuxRegion[] = [dupA, dupB, unique]
    expect(() => resolveAgentMuxRegion(ambiguousSet, { kind: 'region', regionId: 'unique-region' }))
      .toThrowError(expect.objectContaining({
        code: 'AMBIGUOUS_REGION_TARGET',
        message: 'Open Region identity is ambiguous.'
      }))
    // Self-check: dropping the duplicate makes the SAME target resolve cleanly — proving the throw is
    // the duplicate set, not the target. This is exactly the path the mutated guard would take (return
    // `unique`), which is why the assertion above reds when the guard is disabled.
    expect(resolveAgentMuxRegion([dupA, unique], { kind: 'region', regionId: 'unique-region' }))
      .toEqual(unique)
  })

  it('resolveAgentMuxRegion throws REGION_NOT_OPEN when no region matches the target', () => {
    // Kills: the no-match guard condition replaced by `false && …`. With it off, zero matches fall
    // through to the multi-match guard and throw AMBIGUOUS_REGION_TARGET instead, so this asserts the
    // specific code REGION_NOT_OPEN rather than merely "throws".
    expect(() => resolveAgentMuxRegion(regions, { kind: 'region', regionId: 'does-not-exist' }))
      .toThrowError(expect.objectContaining({
        code: 'REGION_NOT_OPEN',
        message: 'Region target is not currently open.'
      }))
    // Self-check: a target that DOES exist in the same set resolves — proving the fixture is well-formed
    // and the throw is the missing id, not an empty/malformed region list.
    expect(resolveAgentMuxRegion(regions, { kind: 'region', regionId: 'browser-right' })).toEqual(regions[1])
  })

  it('resolveAgentMuxRegion throws AMBIGUOUS_REGION_TARGET when an agent-session matches multiple regions', () => {
    // Kills: the multi-match guard condition `matches.length !== 1` replaced by `false && …`. Two agent
    // regions with DISTINCT regionIds (so the duplicate-id guard passes) share one agentSessionId, so an
    // agent-session target matches both. With the guard off the function returns matches[0] instead of
    // erroring. The message 'Region target is ambiguous.' distinguishes this from the duplicate-id branch.
    const first = { ...agentRegion, regionId: 'agent-a', agentSessionId: 'shared-session' }
    const second = { ...agentRegion, regionId: 'agent-b', agentSessionId: 'shared-session' }
    const multiMatch: AgentMuxRegion[] = [first, second]
    expect(() => resolveAgentMuxRegion(multiMatch, { kind: 'agent-session', agentSessionId: 'shared-session' }))
      .toThrowError(expect.objectContaining({
        code: 'AMBIGUOUS_REGION_TARGET',
        message: 'Region target is ambiguous.'
      }))
    // Self-check: with only one of the two present, the same target resolves to exactly that region —
    // proving both individually match, so the throw is the multiplicity, not a malformed fixture. This
    // return of matches[0] is the path the disabled guard takes, which is why the assertion above reds.
    expect(resolveAgentMuxRegion([first], { kind: 'agent-session', agentSessionId: 'shared-session' }))
      .toEqual(first)
  })

  it('requires one typed self caller and rejects legacy operations', () => {
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'self-tab',
      operation: 'inspect.tab',
      target: { kind: 'self' },
      caller: { agentSessionId: 'semantic-1' }
    })).toMatchObject({ operation: 'inspect.tab', target: { kind: 'self' } })
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'missing-caller',
      operation: 'inspect.tab',
      target: { kind: 'self' }
    })).toThrow('managed caller')
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'reserved-explicit-id',
      operation: 'focus',
      target: { kind: 'tab', tabId: 'self' }
    })).toThrow('Focus target')
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'legacy',
      operation: 'context',
      caller: { agentSessionId: 'semantic-1' }
    })).toThrow('operation')
  })

  it('keeps open content and destinations as closed discriminated unions', () => {
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'open-right',
      operation: 'open.agent',
      caller: { agentSessionId: 'semantic-1' },
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'Review' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'self' } }
    })).toMatchObject({ operation: 'open.agent', destination: { kind: 'split', direction: 'right' } })
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'invalid-destination',
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex' },
      destination: { kind: 'recent' }
    })).toThrow('destination')
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'terminal-below',
      operation: 'open.terminal',
      shellCommand: 'pnpm test:fast',
      destination: { kind: 'split', direction: 'down', region: { kind: 'region', regionId: 'agent-left' } }
    })).toMatchObject({ operation: 'open.terminal', shellCommand: 'pnpm test:fast' })
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'browser-tab',
      operation: 'open.browser',
      url: 'http://localhost:5173',
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: 'tab-main' } }
    })).toMatchObject({ operation: 'open.browser', url: 'http://localhost:5173' })
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'arrange',
      operation: 'arrange',
      target: { kind: 'tab', tabId: 'tab-main' },
      mode: { kind: 'preset', preset: 'grid-6' }
    })).toMatchObject({ operation: 'arrange', mode: { kind: 'preset', preset: 'grid-6' } })
  })

  // T-004: promote.region 是一个带 Region 选择器的合法操作，且它的回执携带新 Tab 的坐标
  // （tabId/regionId/workspaceId）——Agent 促升自己后要靠这三件套 focus/inspect 回去。self 选择器
  // 与 inspect.region 同规则：需要 managed caller。
  it('parses promote.region with a self or explicit Region selector and round-trips its receipt', () => {
    // self 需要 managed caller，与 inspect.region 一致。
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'promote-self',
      operation: 'promote.region',
      target: { kind: 'self' },
      caller: { agentSessionId: 'semantic-1' }
    })).toMatchObject({ operation: 'promote.region', target: { kind: 'self' } })
    // 缺 caller 的 self 被拒——证明这条与 inspect.region 共用同一道 managed-caller 闸。
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'promote-self-no-caller',
      operation: 'promote.region',
      target: { kind: 'self' }
    })).toThrow('managed caller')
    // 显式 Region 选择器。
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'promote-region',
      operation: 'promote.region',
      target: { kind: 'region', regionId: 'agent-left' }
    })).toMatchObject({ operation: 'promote.region', target: { kind: 'region', regionId: 'agent-left' } })
    // 回执带出新 Tab 的三件套坐标，逐字段被 identity 校验（空串 / 控制字符会被拒）。
    expect(parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'promote-region',
      ok: true,
      operation: 'promote.region',
      result: { tabId: 'view:new', regionId: 'agent-left', workspaceId: 'workspace' }
    })).toMatchObject({ operation: 'promote.region', result: { tabId: 'view:new', regionId: 'agent-left', workspaceId: 'workspace' } })
    // 回执里的 regionId 是保留选择器 self 时必须拒——那是 identity() 而非 id() 的职责。
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'promote-region',
      ok: true,
      operation: 'promote.region',
      result: { tabId: 'view:new', regionId: 'self', workspaceId: 'workspace' }
    })).toThrow('invalid')
  })

  // promote.region 的 no-op（那格已经就是一张 Tab）抛 REGION_ALREADY_SOLE，而不是笼统的
  // CONTROL_FAILED——调用方据此分辨「已经在那了，别重试」与「真的失败了」。这条钉的是那个码是
  // 联合的真成员、能原样过线：把它从 AGENTMUX_CONTROL_ERROR_CODES 删掉，controlErrorCode 会把它
  // 折成 CONTROL_FAILED，随后 `code === 'CONTROL_FAILED' && error.code !== 'CONTROL_FAILED'` 那道闸
  // 抛 'Control error receipt is invalid.'，这条 toMatchObject 转红。
  it('carries REGION_ALREADY_SOLE through an error receipt as a distinct code, not CONTROL_FAILED', () => {
    expect(parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'promote-sole',
      ok: false,
      operation: 'promote.region',
      error: { code: 'REGION_ALREADY_SOLE', message: 'Region is already the only Region of its Tab.' }
    })).toMatchObject({ ok: false, error: { code: 'REGION_ALREADY_SOLE' } })
  })

  it('preserves typed ambiguous message candidates through receipts', () => {
    expect(parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'send-tab',
      ok: false,
      operation: 'send',
      error: {
        code: 'MESSAGE_TARGET_NOT_UNIQUE',
        message: 'Tab contains multiple Agent Sessions.',
        candidates: [
          { agentSessionId: 'writer', regionIds: ['region-writer'] },
          { agentSessionId: 'reviewer', regionIds: ['region-reviewer', 'region-reviewer-two'] }
        ]
      }
    })).toMatchObject({
      ok: false,
      error: { candidates: [{ agentSessionId: 'writer' }, { agentSessionId: 'reviewer' }] }
    })
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'missing-candidates',
      ok: false,
      operation: 'send',
      error: { code: 'MESSAGE_TARGET_NOT_UNIQUE', message: 'Candidates are required.' }
    })).toThrow('candidates are required')
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'unexpected-candidates',
      ok: false,
      operation: 'send',
      error: {
        code: 'REGION_NOT_OPEN',
        message: 'Region is closed.',
        candidates: [{ agentSessionId: 'writer', regionIds: ['region-writer'] }]
      }
    })).toThrow('candidates are invalid')
  })

  // T-002 发现四态过线：list.agents 的 executor 元信息带 availability 四态之一，逐一透传；
  // 非四态成员（旧的 boolean、拼错的串）一律拒。availability 从 AGENTMUX_EXECUTOR_AVAILABILITIES
  // 派生校验，不另写第二份手抄。
  it('carries the four availability states through list.agents receipts and rejects non-members', () => {
    const listAgents = (availability: unknown) => ({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'list',
      ok: true,
      operation: 'list.agents',
      result: { agents: [{ executorId: 'e1', label: 'One', providerId: 'codex', availability }] }
    })
    for (const availability of ['unknown', 'check-failed', 'missing', 'available'] as const) {
      expect(parseAgentMuxControlReceipt(listAgents(availability)))
        .toMatchObject({ operation: 'list.agents', result: { agents: [{ executorId: 'e1', availability }] } })
    }
    // 旧的 boolean 契约必须被拒——把 enum 折回 boolean 时这条红。
    expect(() => parseAgentMuxControlReceipt(listAgents(true))).toThrow('Executor is invalid')
    // 不在四态里的串也拒——校验必须锚在成员集合上，不是「随便一个 string」。
    expect(() => parseAgentMuxControlReceipt(listAgents('installed'))).toThrow('Executor is invalid')
  })

  it('requires exactly one result or error and rejects reserved result identities', () => {    const success = {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'hybrid',
      ok: true,
      operation: 'send',
      result: { agentSessionId: 'agent-1' }
    }
    expect(() => parseAgentMuxControlReceipt({
      ...success,
      error: { code: 'CONTROL_FAILED', message: 'must not coexist' }
    })).toThrow('exactly one')
    expect(() => parseAgentMuxControlReceipt({
      ...success,
      ok: false,
      error: { code: 'CONTROL_FAILED', message: 'must not coexist' }
    })).toThrow('exactly one')
    for (const receipt of [
      { ...success, result: { agentSessionId: 'self' } },
      { ...success, operation: 'focus', result: { tabId: 'self' } },
      {
        ...success,
        operation: 'inspect.region',
        result: {
          region: {
            tabId: 'tab-main', regionId: 'self', workspaceId: 'workspace', kind: 'launcher',
            bounds: { x: 0, y: 0, width: 1, height: 1 }
          }
        }
      }
    ]) expect(() => parseAgentMuxControlReceipt(receipt)).toThrow('invalid')
  })

  // 方向邻居会被 Agent 直接当作地址喂回 focus/send，所以它是一条**信任边界**：主机说什么就
  // 信什么，等于放行一个没人验证过的寻址目标。此前这一整段校验没有任何断言经过——四个方向
  // 全是 none 的 fixture 走不到 region/tab 两个分支，把校验整段删掉测试照样绿。
  it('校验线上的方向邻居，而不是照单全收', () => {
    const inspected = (neighbors: unknown): unknown => ({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'inspect-region',
      ok: true,
      operation: 'inspect.region',
      result: {
        region: {
          tabId: 'tab-main', regionId: 'region-1', workspaceId: 'workspace', kind: 'launcher',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          neighbors
        }
      }
    })
    const none = { kind: 'none' } as const

    // 合法的 Region / Tab 邻居原样通过——校验不能严到把真答案也挡掉。
    const ok = parseAgentMuxControlReceipt(inspected({
      left: { kind: 'tab', tabId: 'tab-prev' },
      right: { kind: 'region', regionId: 'region-2' },
      up: none,
      down: none
    }))
    expect(ok).toMatchObject({
      operation: 'inspect.region',
      result: { region: { neighbors: { right: { kind: 'region', regionId: 'region-2' } } } }
    })

    // `self` 不是一个具体地址，把它当邻居交出来会让接收方寻址到自己。
    expect(() => parseAgentMuxControlReceipt(inspected({
      left: none, right: { kind: 'region', regionId: 'self' }, up: none, down: none
    }))).toThrow('invalid')

    // 空 id、控制字符同理：这些会被原样拼进后续命令。
    for (const bad of ['', 'region\n2']) {
      expect(() => parseAgentMuxControlReceipt(inspected({
        left: none, right: { kind: 'region', regionId: bad }, up: none, down: none
      }))).toThrow('invalid')
    }

    // 上下答成 Tab 是**语义错误**：Tab 条是一维水平序列。放行它，Agent 会以为自己拿到了上方
    // 的东西，实际拿到的是左邻那张，且无从发现自己被骗。
    for (const direction of ['up', 'down']) {
      expect(() => parseAgentMuxControlReceipt(inspected({
        left: none, right: none, up: none, down: none, [direction]: { kind: 'tab', tabId: 'tab-x' }
      }))).toThrow('invalid')
    }

    // 认不出的 kind、缺字段、整段缺失，都不该被当成"没有邻居"悄悄放过。
    for (const neighbors of [
      { left: none, right: { kind: 'window', windowId: 'w1' }, up: none, down: none },
      { left: none, right: { kind: 'tab' }, up: none, down: none },
      { left: none, right: none, up: none },
      undefined
    ]) expect(() => parseAgentMuxControlReceipt(inspected(neighbors))).toThrow('invalid')
  })
})

describe('external Control control', () => {
  // -------------------------------------------------------------------------
  // 接管一条已存在的 Control socket 之前那道存活闸。三态判定（alive/dead/unknown）与 endpoint
  // 回收共用一份实现（socket-liveness.ts）；本侧要钉的是**这一侧对 unknown 的取舍**：抛
  // CONTROL_UNAVAILABLE，而不是当成「没人占用」继续。
  //
  // 为什么这一条必须存在：start() 判出「没人占用」之后紧接着就 rm 掉那条 socket 并自己 listen
  // 上去。若探不准（权限、超时）被读成「没人」，那次 rm 就会打在一个**活着的** owner 的 socket 上，
  // 于是两个进程同时认为自己拥有同一条 Control 端点。删掉那句 unknown 守卫时本文件全绿（实测），
  // 所以它此前无人守。
  // -------------------------------------------------------------------------
  it('refuses to take over an endpoint whose liveness cannot be determined', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-control-probe-')
    roots.push(root)
    const path = join(root, 'control.sock')

    // 造一个「探不动但确实存在」的 socket：先真的 listen 出一个 socket 节点，再把它 chmod 000。
    // 这样 lstat/isSocket/uid 三道前置检查全部通过（实测 isSocket() 仍为 true），探测才会真的发生，
    // 而 connect 得 EACCES（实测）——正是「说不准」的真实来路之一。
    const occupant = createServer()
    await new Promise<void>((resolve, reject) => {
      occupant.once('error', reject)
      occupant.listen(path, () => resolve())
    })
    await chmod(path, 0o000)

    const server = new AgentMuxControlServer({
      async execute(): Promise<AgentMuxControlResult> {
        throw new Error('must not be reached: start() should refuse before serving')
      }
    }, path)

    try {
      // 必须抛，而且必须是「判不准」这条码，不能是 CONTROL_OWNER_BUSY——后者是「确认有人」，
      // 而我们恰恰不知道。也不能静默成功：那意味着它已经把占用者的 socket 删掉了。
      await expect(server.start()).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
      // 判据同时落在文件系统上：占用者的 socket 必须还在，一个字节都不许动。
      await chmod(path, 0o600)
      expect((await stat(path)).isSocket()).toBe(true)
    } finally {
      await chmod(path, 0o700).catch(() => {})
      await server.stop().catch(() => {})
      await new Promise<void>((resolve) => occupant.close(() => resolve()))
    }
  })

  it('carries the new protocol through one owner endpoint', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-composition-control-')
    roots.push(root)
    const path = join(root, 'control.sock')
    const seen: string[] = []
    const server = new AgentMuxControlServer({
      async execute(request): Promise<AgentMuxControlResult> {
        seen.push(request.operation)
        if (request.operation === 'inspect.tab') {
          return {
            operation: request.operation,
            tab: {
              tabId: 'tab-main',
              workspaceId: 'workspace',
              regions: [{ ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors }]
            }
          }
        }
        if (request.operation === 'list.agents') return { operation: request.operation, agents: [{ executorId: 'codex', providerId: 'codex', label: 'Codex', availability: 'available' }] }
        if (request.operation === 'open.agent') return { operation: request.operation, region: agentRegion }
        if (request.operation === 'open.terminal') return { operation: request.operation, region: terminalRegion }
        if (request.operation === 'open.browser') return { operation: request.operation, region: browserRegion }
        if (request.operation === 'send') {
          if (request.text === 'invalid candidates') {
            throw Object.assign(new Error('Invalid candidates'), {
              code: 'MESSAGE_TARGET_NOT_UNIQUE',
              candidates: [{ agentSessionId: '', regionIds: [] }]
            })
          }
          return { operation: request.operation, agentSessionId: 'semantic-1' }
        }
        if (request.operation === 'focus') return { operation: request.operation, tabId: 'tab-main', regionId: 'agent-left' }
        if (request.operation === 'arrange') return {
          operation: request.operation,
          tab: {
            tabId: 'tab-main',
            workspaceId: 'workspace',
            regions: [{ ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors }]
          }
        }
        if (request.operation === 'inspect.region') return { operation: request.operation, region: { ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors } }
        if (request.operation === 'resume') return { operation: request.operation, agentSessionId: 'semantic-1', runId: 'run-resumed' }
        if (request.operation === 'interrupt' || request.operation === 'stop') return { operation: request.operation, agentSessionId: 'semantic-1' }
        throw new Error('Unexpected operation')
      }
    }, path)
    await server.start()
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'inspect-tab',
      operation: 'inspect.tab',
      target: { kind: 'tab', tabId: 'tab-main' }
    }, path)).resolves.toMatchObject({ operation: 'inspect.tab', result: { tab: { tabId: 'tab-main' } } })
    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'open-agent',
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'agent-left' } }
    }, path)).resolves.toMatchObject({ operation: 'open.agent', result: { region: { tabId: 'tab-main' } } })
    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'send',
      operation: 'send',
      target: { kind: 'tab', tabId: 'tab-main' },
      text: 'Continue'
    }, path)).resolves.toMatchObject({ operation: 'send', result: { agentSessionId: 'semantic-1' } })
    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'invalid-candidates',
      operation: 'send',
      target: { kind: 'tab', tabId: 'tab-main' },
      text: 'invalid candidates'
    }, path)).rejects.toMatchObject({ code: 'CONTROL_FAILED' })
    expect(seen).toEqual(['inspect.tab', 'open.agent', 'send', 'send'])
    await server.stop()
  })

  it('decodes UTF-8 only after all socket chunks are joined', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-composition-utf8-')
    roots.push(root)
    const path = join(root, 'control.sock')
    let seen = ''
    const server = new AgentMuxControlServer({
      async execute(request) {
        if (request.operation !== 'send') throw new Error('Unexpected operation')
        seen = request.text
        return { operation: request.operation, agentSessionId: 'semantic-1' }
      }
    }, path)
    await server.start()
    await requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'utf8-send',
      operation: 'send',
      target: { kind: 'agent-session', agentSessionId: 'semantic-1' },
      text: '继续检查'
    }, path)
    expect(seen).toBe('继续检查')
    await server.stop()
  })

  it.each([
    ['request ID', 'another-request', 'send'],
    ['operation', 'expected-request', 'stop']
  ])('rejects a valid error receipt with another %s', async (_identity, requestId, operation) => {
    const root = await mkdtemp('/private/tmp/agentmux-control-wrong-receipt-')
    roots.push(root)
    const path = join(root, 'control.sock')
    const server = createServer((socket) => {
      socket.once('data', () => socket.end(`${JSON.stringify({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId,
        ok: false,
        operation,
        error: { code: 'REGION_NOT_OPEN', message: 'Another request failed.' }
      })}\n`))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })

    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'expected-request',
      operation: 'send',
      target: { kind: 'agent-session', agentSessionId: 'agent-1' },
      text: 'Continue'
    }, path)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

/**
 * 等待预算与「哪些操作算慢」都只有一处。
 *
 * 同一条 `amux open.agent` 有两条到达执行方的路，各有一个等待方：这里的 CLI→daemon socket，以及
 * Renderer 拥有屏幕时 main→Renderer 的 IPC 桥（apps/desktop 的 control-ipc-bridge）。此前两侧各手抄
 * `2_000` / `60_000`，而**「哪些操作算慢」在这边是命名函数 `longOperation`、在桥那边被内联展开成同样
 * 的四项析取**。后果：加一个慢操作时只改一侧的人会得到一个全绿的仓库，而另一条路静默给它 2 秒——
 * 用户看到的是「同一个命令有时能开出来、有时报 CONTROL_TIMEOUT」，差别只在当时是谁拥有屏幕。
 *
 * 取值与语义归 core（本文件钉），「桥有没有真的从这一处取」归 desktop 那侧的守卫钉。
 */
describe('Control 等待预算与慢操作判据只有一处', () => {
  const hostSource = readFileSync(new URL('../src/control-host.ts', import.meta.url), 'utf8')

  it('长操作等长预算、短操作等短预算', () => {
    expect(agentMuxControlTimeoutMs('open.agent')).toBe(AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS)
    expect(agentMuxControlTimeoutMs('inspect.tab')).toBe(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
    // 自检：两个预算相等时上面两条恒真，整族退化成装饰。
    expect(
      AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS,
      '长短预算相等，这一族分辨不出任何东西'
    ).toBeGreaterThan(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
  })

  it('慢的是「要等外面」的那些，快的是只读/只动本地状态的', () => {
    // 判据落在**语义**上：等进程起来、等 composer 就绪、等 Provider 重建会话、等进程收尾——这四类要长
    // 预算；inspect/focus/arrange/promote/list 两秒内不返回就是真出事了。
    //
    // 为什么是一张 `Record<Operation, …>` 而不是两个 `as const` 数组：数组是**手抄的清单**，往联合里加
    // 一个操作时它不在任何一个数组里，这一条照旧全绿，新操作的档位就成了没人守的自由变量。实测过：
    // `promote.region` 落地时正是这样漏掉的——把它的档位从 short 改成 long（真回归：一个纯本地的布局
    // 操作会占满 30 秒长预算），control-host 与 union-membership 同跑全绿——当时是 40 条，那个数只是
    // 那次测量的快照，不是今天的总数。
    //
    // 改成穷尽 Record 之后这件事由 **tsc** 买单：缺键 TS2741、多键 TS2353，而 packages/core 的 tsconfig
    // 覆盖 test/，所以这是真被执行的约束。下一个操作加进联合时，这里编译不过，作者必须回答「它等不等
    // 外面」。这与下面那条守 OPERATION_BUDGET 注解不退化的用例是一对：那条守生产侧的表不许放宽，
    // 这条守判据侧的表不许漏人。
    const EXPECTED_BUDGET: Record<AgentMuxControlRequest['operation'], 'long' | 'short'> = {
      // 要等外面的。
      'open.agent': 'long',
      'open.terminal': 'long',
      'open.browser': 'long',
      send: 'long',
      resume: 'long',
      stop: 'long',
      // 只读或只动本地状态的。
      'inspect.tab': 'short',
      'inspect.region': 'short',
      focus: 'short',
      arrange: 'short',
      // promote 只在本地布局树上搬一片叶子，不碰 Runtime lifecycle（见 store 的 promote.region 臂：
      // 那条路径上没有任何 api.sessions.* 调用），所以它和 arrange 同档。
      'promote.region': 'short',
      'list.agents': 'short',
      // interrupt 拿短预算是**判过**的：它只往 daemon 发一次信号（ctxmux-run-adapter.ts 的
      // `interrupt()` 就一个 await），不像 stop 要等 attachRecoverableStop 真的收尾。
      interrupt: 'short'
    }
    const entries = Object.entries(EXPECTED_BUDGET) as [AgentMuxControlRequest['operation'], 'long' | 'short'][]
    // 自检：表空了下面的循环就是死代码。条数由 tsc 钉住，这里只防「Object.entries 拿到空」这种失灵。
    expect(entries.length, '档位期望表是空的，本条是死代码').toBeGreaterThan(10)
    const drifted = entries
      .filter(([operation, expected]) => isLongAgentMuxControlOperation(operation) !== (expected === 'long'))
      .map(([operation, expected]) => `${operation}: 期望 ${expected}，实际 ${expected === 'long' ? 'short' : 'long'}`)
      .sort()
    expect(drifted, '有操作的等待预算与它的语义不符').toEqual([])
  })

  it('每个操作都被显式定过档——分档表必须是穷尽 Record，不许退回按形状推断', () => {
    // 此前的分档是个谓词（`startsWith('open.') || === 'send' || …`）。谓词只能表达「符合这形状的算慢」，
    // 而**新操作不符合任何形状时会静默落进快档**：`interrupt` 加进联合类型时就没有任何东西提醒过
    // 要给它定档，它只是不匹配。
    //
    // 「每个成员都在表里」这件事**由 tsc 买单**：`Record<Operation, …>` 缺键报 TS2741、多键报 TS2353，
    // 而 packages/core 的 tsconfig 覆盖 src/ 与 test/，所以那是真被执行的约束。于是这条不再遍历一份
    // 抽出来的清单去数行数（那种数法与 tsc 重复，且抽取器本身要靠自检才不假绿）——它守的是**让 tsc
    // 有资格管这件事的那个前提**：注解一旦被放宽成 `Record<string, …>` 或 `Partial<Record<…>>`，
    // 缺键就重新变成沉默的，而所有取值断言照旧全绿。这是纯文本判据唯一买得到、tsc 自己买不到的东西。
    //
    // 成员覆盖面在 union-membership-ssot.test.ts：那边有一份被 tsc 钉成联合全集的锚点，并让十三个操作
    // 逐个走真正的 parseAgentMuxControlRequest。这条只管注解不退化。
    const controlSource = readFileSync(new URL('../src/control.ts', import.meta.url), 'utf8')
    const annotation = /const OPERATION_BUDGET\s*:\s*([^=]+?)\s*=/.exec(controlSource)?.[1]
    expect(annotation, 'control.ts 里 OPERATION_BUDGET 没有类型注解——缺键不再报错，分档回到「你得记得改」').toBeTruthy()
    expect(
      annotation!.replace(/\s+/g, ' '),
      'OPERATION_BUDGET 的注解不是穷尽 Record：一旦放宽成 Record<string, …> 或 Partial<Record<…>>，' +
        '往联合加操作时缺一行不会报错，新操作靠「表里查不到」拿到短预算——正是 interrupt 当年的形状'
    ).toBe("Record<AgentMuxControlRequest['operation'], 'long' | 'short'>")

    const table = /const OPERATION_BUDGET[\s\S]*?\n\}/.exec(controlSource)?.[0]
    expect(table, 'control.ts 里找不到 OPERATION_BUDGET 那张表').toBeTruthy()
    // 自检：两档都真的在表里出现过——整张表写成同一档时，上面那些取值断言才是唯一防线，
    // 这里先保证表本身没退化成单档。
    expect(table).toContain("'long'")
    expect(table).toContain("'short'")
    // 自检：判据认得出被放宽的注解，否则上面那条 toBe 只是在描述今天的字面量。
    for (const weakened of [
      "const OPERATION_BUDGET: Record<string, 'long' | 'short'> = {",
      "const OPERATION_BUDGET: Partial<Record<AgentMuxControlRequest['operation'], 'long' | 'short'>> = {"
    ]) {
      expect(
        /const OPERATION_BUDGET\s*:\s*([^=]+?)\s*=/.exec(weakened)?.[1]?.replace(/\s+/g, ' '),
        '判据认不出被放宽的注解'
      ).not.toBe("Record<AgentMuxControlRequest['operation'], 'long' | 'short'>")
    }
  })

  it('control-host 从 control.ts 取预算，不再自己算一遍', () => {
    // 判 import 关系而不是「没有 60_000 这个字面量」：换个写法（`60 * 1_000`、`6e4`、一个中间常量）
    // 就能绕过字面量判据，而「自己算一遍」这件事照旧发生。
    const IMPORT_SHAPE = /import\s*\{[\s\S]*?\bagentMuxControlTimeoutMs\b[\s\S]*?\}\s*from\s*'\.\/control\.js'/
    expect(
      IMPORT_SHAPE.test(hostSource),
      'control-host 没有从 ./control.js 导入 agentMuxControlTimeoutMs：预算又变成两处各算一遍'
    ).toBe(true)
    // 自检：正则认得出它要找的那种形状，否则上面那条是死代码。
    expect(
      IMPORT_SHAPE.test("import {\n  agentMuxControlTimeoutMs\n} from './control.js'"),
      '判据认不出正常的导入写法'
    ).toBe(true)

    // 「哪些操作算慢」也不许在这里重写一遍（本文件曾有个 longOperation() 就是那份副本）。
    // 判据不是「某个禁止形状不在场」——那种判法拦不住换个拼法，也会误伤本文件大量按操作解析请求的
    // `source.operation === 'send'` 派发。这里逐个抽出每一处 setTimeout 的延时位，**分站点**质询。
    //
    // 为什么必须分站点：此前这里是一张两个名字的白名单，对所有站点一视同仁，于是
    // `AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS` 在**每一处**都合法。把服务端读到请求后重排的那处与
    // 客户端发起的那处（两处都是 `agentMuxControlTimeoutMs(request.operation)`）换成那个短常量，
    // 长操作全部退化成 2 秒（`amux open.agent` 起一个 Agent 必然超时），而这一族 14/14 全绿——
    // 我实测过两次，都存活。短常量只在**读到请求之前**那一处才是对的。
    // 刻意不写行号：行号会随上游漂。这段注释上一版举的那两个号码写下时就已失准，其中一个指的恰恰是
    // 短常量那一处——与本段论述正好相反。按「哪一处、用的哪个表达式」来指认，读者 grep 得到，也不会过期。
    const delays = [...hostSource.matchAll(/\.setTimeout\(\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/g)]
      .map((match) => match[1]!)
    const PER_OPERATION = 'agentMuxControlTimeoutMs(request.operation)'
    const PRE_PARSE = 'AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS'

    // 恰好一处可以用短常量：还没读到请求，不知道是哪个操作，只能按短预算等第一条消息。
    expect(
      delays.filter((delay) => delay === PRE_PARSE),
      `用短常量当延时的 setTimeout 应当恰好一处（读到请求之前那一处）；实际：${delays.join(' | ')}`
    ).toHaveLength(1)
    // 其余每一处都必须按操作取值。少一处就有一条路把长操作按 2 秒等。
    const perOperation = delays.filter((delay) => delay === PER_OPERATION)
    expect(
      perOperation.length,
      `按操作取预算的 setTimeout 少于两处（读到请求后重排、以及客户端侧发起）；实际：${delays.join(' | ')}`
    ).toBeGreaterThanOrEqual(2)
    // 且没有第三种写法——谁想自己算一遍，那个表达式会落在这里。
    expect(
      delays.filter((delay) => delay !== PRE_PARSE && delay !== PER_OPERATION),
      '有 setTimeout 的延时位既不是那一处短常量、也不是按操作取值'
    ).toEqual([])

    // 自检：抽取器真的找到了那些调用点，否则上面几条按数量判的会恒真。
    expect(delays.length, 'setTimeout 延时位抽取器一个都没找到，上面那几条守卫是死代码').toBeGreaterThanOrEqual(3)
    // 自检：抽取器认得出「自己算一遍」的那种拼法。
    const historical = `socket.setTimeout(longOperation(request.operation) ? LONG : SHORT, () => socket.destroy())`
    const probed = [...historical.matchAll(/\.setTimeout\(\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/g)].map((m) => m[1]!)
    expect(probed, '抽取器认不出内联算一遍的形状，那条守卫是死代码').toEqual(['longOperation(request.operation)'])
  })
})
