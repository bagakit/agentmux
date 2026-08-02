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

  it('requires exactly one result or error and rejects reserved result identities', () => {
    const success = {
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
        if (request.operation === 'list.agents') return { operation: request.operation, agents: [{ executorId: 'codex', providerId: 'codex', label: 'Codex', available: true }] }
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
    // 判据落在**语义**上而不是抄一份清单：等进程起来、等 composer 就绪、等 Provider 重建会话、
    // 等进程收尾——这四类要长预算；inspect/focus/arrange/list 两秒内不返回就是真出事了。
    for (const operation of ['open.agent', 'open.terminal', 'open.browser', 'send', 'resume', 'stop'] as const) {
      expect(isLongAgentMuxControlOperation(operation), `${operation} 要等外面，必须走长预算`).toBe(true)
    }
    for (const operation of ['inspect.tab', 'inspect.region', 'focus', 'arrange', 'list.agents'] as const) {
      expect(isLongAgentMuxControlOperation(operation), `${operation} 只读或只动本地状态，不该占长预算`).toBe(false)
    }
    // interrupt 拿短预算是**判过**的：它只往 daemon 发一次信号（ctxmux-run-adapter.ts 的
    // `interrupt()` 就一个 await），不像 stop 要等 attachRecoverableStop 真的收尾。
    expect(isLongAgentMuxControlOperation('interrupt'), 'interrupt 只发一次信号，不该占长预算').toBe(false)
  })

  it('每个操作都被显式定过档——新加一个不许靠「不匹配」落进快的那档', () => {
    // 此前的分档是个谓词（`startsWith('open.') || === 'send' || …`）。谓词只能表达「符合这形状的算慢」，
    // 而**新操作不符合任何形状时会静默落进快档**：`interrupt` 加进联合类型时就没有任何东西提醒过
    // 要给它定档，它只是不匹配。这条钉住联合里每个成员在源码里都被逐字提到过，于是加成员时
    // Record 缺键让 tsc 报错，而不是等到用户看见一个 2 秒就超时的慢操作。
    const controlSource = readFileSync(new URL('../src/control.ts', import.meta.url), 'utf8')
    const table = /const OPERATION_BUDGET[\s\S]*?\n\}/.exec(controlSource)?.[0]
    expect(table, 'control.ts 里找不到 OPERATION_BUDGET 那张表——分档又变回按形状推断了').toBeTruthy()

    // 遍历源取 control-host 自己那份运行期清单（解析请求时校验用的 OPERATIONS），从源码里抽出来而不是
    // 在这里手抄一份：手抄的那份只在「正好是缺陷所在」时才与真清单分岔，选错源会得出自信的反向结论
    // （derivation-source-must-be-the-consumed-one）。顺带把「两份清单发散」也钉住了。
    const runtimeList = /const OPERATIONS = \[([\s\S]*?)\] as const/.exec(hostSource)?.[1]
    expect(runtimeList, 'control-host 里找不到 OPERATIONS 那份运行期清单').toBeTruthy()
    const operations = [...runtimeList!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
    // 自检：真抽到了成员，否则下面的循环跑零次、恒绿。
    expect(operations.length, 'OPERATIONS 抽取器一个成员都没抽到，下面那个循环是死代码').toBeGreaterThanOrEqual(12)

    for (const operation of operations) {
      expect(
        new RegExp(`(^|[^\\w.'"])'?${operation.replace('.', '\\.')}'?\\s*:`, 'm').test(table!),
        `OPERATION_BUDGET 里没有 \`${operation}\` 这一行——它会靠「不匹配」拿到某一档，而不是被判过`
      ).toBe(true)
    }
    // 自检：判据认得出缺行，否则上面那个循环恒真。
    const missing = "const OPERATION_BUDGET = {\n  'inspect.tab': 'short',\n  stop: 'long'\n}"
    expect(
      /(^|[^\w.'"])'?send'?\s*:/m.test(missing),
      '判据认不出「表里没有 send 这一行」，那个循环是死代码'
    ).toBe(false)
    // 自检：两档都真的在表里出现过——整张表写成同一档时，取值那条断言才是唯一防线，
    // 这里先保证表本身没退化成单档。
    expect(table).toContain("'long'")
    expect(table).toContain("'short'")
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
    // `AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS` 在**每一处**都合法。把 :480 与 :508 那两处按操作重排的
    // 延时换成那个短常量，长操作全部退化成 2 秒（`amux open.agent` 起一个 Agent 必然超时），
    // 而这一族 14/14 全绿——我实测过两次，都存活。短常量只在读到请求之前那一处才是对的。
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
