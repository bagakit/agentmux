import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxControlServer,
  parseAgentMuxControlReceipt,
  parseAgentMuxControlRequest,
  requestAgentMuxControl,
  subscribeAgentMuxControl
} from '../src/control-host.js'
import {
  AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  agentMuxControlTimeoutMs,
  isLongAgentMuxControlOperation,
  resolveAgentMuxRegion,
  type AgentMuxAgentRegion,
  type AgentMuxControlBrowserEvent,
  type AgentMuxControlBrowserOperation,
  type AgentMuxControlHost,
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

  // T-008: browser.run 是对外契约的**全部**——页面能力（snapshot/click/...）都在子进程注入的函数库里，
  // 那是内部 API。这一族钉的是这条操作在契约两侧（请求 / 回执）都真的存在且形状被校验。
  it('parses browser.run with its Browser target and multi-line program', () => {
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-basic',
      operation: 'browser.run',
      browserId: 'browser:1',
      code: 'const page = await snapshot()\nreturn page.title'
    })).toMatchObject({
      operation: 'browser.run',
      browserId: 'browser:1',
      code: 'const page = await snapshot()\nreturn page.title'
    })
    // 承重：程序必须走 text() 而不是 id()。换成 id() 之后单行程序照样过，只有带换行的会被拒——
    // 而真实的 Agent 程序**全是**多行的，那个缺陷会以"我的脚本报 INVALID_CONTROL_REQUEST"出现。
    // 上面那条已经带了 \n，这里再钉一条纯多行的，让意图无法被读成巧合。
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-multiline',
      operation: 'browser.run',
      browserId: 'browser:1',
      code: ['await click("@e1")', 'await waitForLoad()', 'return await snapshot()'].join('\n')
    })).toMatchObject({ operation: 'browser.run' })
    // browserId 走 identity()：保留选择器 self 要被拒——browser.run 没有 self 语义，
    // 目标永远是显式的一个 Browser。
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-self-browser',
      operation: 'browser.run',
      browserId: 'self',
      code: 'return 1'
    })).toThrow('Browser target')
    // 没有程序就没有这次请求。缺席被静默收成空串的话，Agent 会拿到一份"跑完了、什么都没发生"的
    // 成功回执——那正是 AGENTS.md:32-52 禁止的那种分不清。
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-no-code',
      operation: 'browser.run',
      browserId: 'browser:1'
    })).toThrow('Browser script')
    // **在场但是空的，与缺席同罪（T-002）。** 此前只有 CLI 拦这一种，协议层的 `text()` 接受空串，
    // 于是直连协议的客户端（编辑器、将来的适配器、另一个语言写的客户端）发一段空程序会拿到那次
    // 不确定的成功，而走 CLI 的拿到明确拒绝——同一条规则两种结果。规则下沉到这一层之后所有
    // 客户端经同一条。
    //
    // 空串与纯空白两种都要判：只判空串会放过 `'   '`——它同样什么都不做，同样给出那份无法区分的
    // 成功回执。三种空白形态各钉一次（空串 / 空格 / 换行与制表），因为 `trim()` 换成
    // `length === 0` 时只有后两种会红。
    for (const [label, code] of [['空串', ''], ['纯空格', '   '], ['换行与制表', '\n\t\n']] as const) {
      expect(() => parseAgentMuxControlRequest({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: `run-empty-${label}`,
        operation: 'browser.run',
        browserId: 'browser:1',
        code
      }), `${label}的程序被放过了——回执会是一份"跑完了、什么都没发生"的成功`).toThrow(/empty/i)
    }
    // 码也要钉：拒绝得用 typed 的 INVALID_CONTROL_REQUEST，机读侧才分得出「我给的请求不合法」
    // 与「那边坏了」。只判 message 的话，抛一个没有码的普通 Error 也会绿。
    try {
      parseAgentMuxControlRequest({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: 'run-empty-code-class',
        operation: 'browser.run',
        browserId: 'browser:1',
        code: '   '
      })
      throw new Error('空程序没被拒——下面的码断言没有作用对象')
    } catch (error) {
      expect((error as { code?: string }).code, '空程序的拒绝不是 typed 的').toBe('INVALID_CONTROL_REQUEST')
      // 文案要对两种调用方都可执行：走 CLI 的人忘了接管道，直连的客户端把 code 设成了空串。
      expect(String((error as Error).message), '拒绝空程序时没告诉走 CLI 的人怎么喂程序').toContain('Pipe it in')
      expect(String((error as Error).message), '拒绝空程序时没告诉直连客户端该设哪个字段').toContain('code')
    }
  })

  it('parses Browser history and replay receipts without losing operation identity', () => {
    const history = parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'history', operation: 'browser.history', browserId: 'browser:1'
    })
    expect(history).toMatchObject({ operation: 'browser.history', browserId: 'browser:1' })
    const operation = { id: 'op:replay', browserId: 'browser:1', operator: { id: 'agent:test', name: 'Test Agent' }, startedAt: 1, phase: 'completed', summary: 'done', url: 'https://example.test/', steps: [] }
    const replay = parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'replay', ok: true, operation: 'browser.replay',
      result: { result: { ok: true }, logs: [], outcome: { kind: 'completed' }, runOperation: operation }
    })
    expect(replay).toMatchObject({ operation: 'browser.replay', result: { runOperation: { id: 'op:replay' } } })
  })

  it('parses explicit Browser replay modes and step selectors', () => {
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'preview', operation: 'browser.replay', browserId: 'browser:1', operationId: 'op:1', mode: 'preview'
    })).toMatchObject({ operation: 'browser.replay', mode: 'preview' })
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'step', operation: 'browser.replay', browserId: 'browser:1', operationId: 'op:1', mode: 'step', step: 2
    })).toMatchObject({ operation: 'browser.replay', mode: 'step', step: 2 })
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'bad-step', operation: 'browser.replay', browserId: 'browser:1', operationId: 'op:1', mode: 'step'
    })).toThrow(/step is required/i)
    // **非法的 step 取值只有这一处判（T-002）。** 此前 CLI 也用正则各判一遍、拿自己的
    // `INVALID_CLI_ARGUMENT` 拒同一个输入，于是同一个非法 step 经两条路得到两个码——机读侧分不出
    // 「这个值不能用」和「命令打错了」。四种非法形态各钉一次并且**都要落在同一个码上**：
    // 分两步校验（先 finiteNumber 再 isInteger）时，非数字会落到 CONTROL_PROTOCOL_ERROR 而 0
    // 落到 INVALID_CONTROL_REQUEST，同一件事长出两个码，那正是本 task 要消除的形状。
    for (const [label, step] of [['零', 0], ['负数', -1], ['小数', 1.5], ['非数字', '2']] as const) {
      let thrown: unknown = null
      try {
        parseAgentMuxControlRequest({
          schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
          requestId: `bad-step-${label}`, operation: 'browser.replay', browserId: 'browser:1', operationId: 'op:1', mode: 'step', step
        })
      } catch (error) { thrown = error }
      expect(thrown, `${label}的 step 被放过了`).not.toBeNull()
      expect((thrown as { code?: string }).code, `${label}的 step 拒绝落在了别的码上——同一件事两个码`)
        .toBe('INVALID_CONTROL_REQUEST')
    }
  })

  // T-003/T-004/T-005：operation 的寿命长于任何一条连接，所以「凭 id 取消」「凭 id 查询」和
  // 「开跑前就拿到 id」是同一条链子上的三环，缺任何一环前两条只对已结束的操作有效，等于没有。
  it('carries a caller-supplied operationId on browser.run so the in-flight operation is addressable', () => {
    const parsed = parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-with-id', operation: 'browser.run', browserId: 'browser:1',
      code: 'return await snapshot()', operationId: 'op:mine'
    })
    // **这一条就是整条链子的前提。** 把 operationId 从请求里摘掉（或在解析臂里不透传），
    // 调用方只能等终局回执才知道 id——而那时已无可取消，browser.stop 与 browser.operation
    // 只对已结束的操作有效。
    expect(parsed, '调用方给的 operationId 没进请求——在飞期间凭 id 够不着这个操作')
      .toMatchObject({ operation: 'browser.run', operationId: 'op:mine' })
    // 可选：不关心 identity 的调用方（发一次就等结果）不该被逼着造一个 uuid。缺席时**不许**
    // 冒出一个键——那会让下游分不出「调用方给了空的」和「调用方没给」。
    const without = parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-no-id', operation: 'browser.run', browserId: 'browser:1', code: 'return 1'
    })
    expect('operationId' in without, '没给 id 却凭空出现了一个键').toBe(false)
    // 非法 id 走同一个 identity() 闸：`self` 是保留选择器（没有哪个操作叫 self），空白与换行
    // 在标识符里没有意义。放过去的话它会被当成字面 id 发出去，错法变成"查不到这个操作"，
    // 把一次参数错误伪装成环境问题。
    for (const [label, operationId] of [['空串', ''], ['纯空格', '  '], ['self', 'self'], ['带换行', 'op\n1']] as const) {
      expect(() => parseAgentMuxControlRequest({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: `run-bad-id-${label}`, operation: 'browser.run', browserId: 'browser:1',
        code: 'return 1', operationId
      }), `${label}的 operationId 被放过了`).toThrow(/operation id/i)
    }
  })

  it('parses browser.stop and browser.operation by operationId alone, with null as a legal answer', () => {
    // 两条都**不收 browserId**：id 本身定位到那一个操作。要求调用方同时给 browserId 会引入
    // 「两个参数互相矛盾时听谁的」这条没必要的裂缝，而协议调用方手上往往真的只有 id——
    // 它不知道也不该需要知道那个操作跑在哪个 Browser 上。
    for (const operation of ['browser.stop', 'browser.operation'] as const) {
      expect(parseAgentMuxControlRequest({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: `req-${operation}`, operation, operationId: 'op:1'
      }), `${operation} 没解析出 operationId`).toMatchObject({ operation, operationId: 'op:1' })
      // 缺 id 是 typed 拒绝：一条没有目标的取消/查询没有任何合法含义。
      let thrown: unknown = null
      try {
        parseAgentMuxControlRequest({
          schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `req-${operation}-noid`, operation
        })
      } catch (error) { thrown = error }
      expect(thrown, `${operation} 缺 operationId 被放过了`).not.toBeNull()
      expect((thrown as { code?: string }).code, `${operation} 缺 id 的拒绝不是 typed 的`)
        .toBe('INVALID_CONTROL_REQUEST')
    }
    const operation = { id: 'op:1', browserId: 'browser:1', operator: { id: 'agent:test', name: 'Test Agent' }, startedAt: 1, phase: 'running', summary: 'Agent is operating the Browser', url: 'https://example.test/', steps: [] }
    // 回执两侧：答出那条操作的事实，**以及**答出 `null`。
    //
    // `null` 是一次成功的回答，不是解析失败：id 可能来自另一台机器、或者早被日志轮转掉了。
    // 把「我们查不到」报成协议错误会让调用方以为 Browser 出了问题（RED-LINES 第 2 类）。
    for (const op of ['browser.stop', 'browser.operation'] as const) {
      expect(parseAgentMuxControlReceipt({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: `receipt-${op}`, ok: true, operation: op, result: { runOperation: operation }
      }), `${op} 的回执丢了 operation 事实`).toMatchObject({ operation: op, result: { runOperation: { id: 'op:1', phase: 'running' } } })
      expect(parseAgentMuxControlReceipt({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: `receipt-${op}-null`, ok: true, operation: op, result: { runOperation: null }
      }), `${op} 把「查不到」当成了解析失败`).toMatchObject({ operation: op, result: { runOperation: null } })
    }
    // 四档 phase 经线上互不折叠。查询的全部价值在于分得出这四个——尤其 `indeterminate`：
    // 它意味着「这件事做到哪儿我们不知道」，调用方对它唯一正确的反应是**别盲目重试**。
    // 折进 failed 的话，同一次重启后的操作会被读成"失败了，改完重跑"。
    const phases = ['running', 'completed', 'stopped', 'indeterminate'] as const
    const roundTripped = phases.map((phase) => {
      const receipt = parseAgentMuxControlReceipt({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: `receipt-phase-${phase}`, ok: true, operation: 'browser.operation',
        result: { runOperation: { ...operation, phase } }
      })
      if (!receipt.ok || receipt.operation !== 'browser.operation' || !receipt.result.runOperation) {
        throw new Error('not a browser.operation success receipt')
      }
      return receipt.result.runOperation.phase
    })
    // 自检：四条都真的过了线，否则下面的去重判据在对空气生效。
    expect(roundTripped, '不是四档都被解析出来').toEqual([...phases])
    expect(new Set(roundTripped).size, '四档 phase 在线上被折并了').toBe(4)
  })

  it('round-trips a browser.run receipt with its logs and four-class outcome', () => {
    const operation = { id: 'op:test', browserId: 'browser:1', operator: { id: 'agent:test', name: 'Test Agent' }, startedAt: 1, phase: 'completed', summary: 'done', url: 'https://example.test/', steps: [] }
    expect(parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-basic',
      ok: true,
      operation: 'browser.run',
      result: { result: { title: 'Example' }, logs: ['clicked @e1'], outcome: { kind: 'completed' }, runOperation: operation }
    })).toMatchObject({
      operation: 'browser.run',
      result: { result: { title: 'Example' }, logs: ['clicked @e1'], outcome: { kind: 'completed' } }
    })
    // 失败也带日志。程序炸掉之前打的那几行往往正是 Agent 需要的——这条钉的是失败路径不丢日志。
    expect(parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-failed',
      ok: true,
      operation: 'browser.run',
      result: {
        logs: ['got this far'],
        outcome: { kind: 'script-failed', message: 'element is gone' }, runOperation: operation
      }
    })).toMatchObject({
      result: { logs: ['got this far'], outcome: { kind: 'script-failed', message: 'element is gone' } }
    })
  })

  // 承重的一条。四类结局若在线上被折成两类（成功 / 失败），"做到哪一步不知道"就消失了——而那正是
  // 真实危险所在：indeterminate 意味着页面上**可能已经点过一次**，调用方不许重试。
  it('keeps all four browser.run outcome classes distinct on the wire', () => {
    const operation = { id: 'op:test', browserId: 'browser:1', operator: { id: 'agent:test', name: 'Test Agent' }, startedAt: 1, phase: 'completed', summary: 'done', url: 'https://example.test/', steps: [] }
    const outcomes = [
      { kind: 'completed' },
      { kind: 'script-failed', message: 'boom' },
      { kind: 'stopped', message: 'script ran past its 60s budget' },
      { kind: 'indeterminate', message: 'the script process died without reporting a result' }
    ]
    const parsed = outcomes.map((outcome) => {
      const receipt = parseAgentMuxControlReceipt({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: 'run-outcomes',
        ok: true,
        operation: 'browser.run',
        result: { logs: [], outcome, runOperation: operation }
      })
      if (!receipt.ok || receipt.operation !== 'browser.run') throw new Error('not a browser.run success receipt')
      return receipt.result.outcome.kind
    })
    // 自检：四条都真的过了线，否则下面的去重判据在对空气生效（AGENTS.md:85-88）。
    expect(parsed, '不是四条都被解析出来').toHaveLength(4)
    expect(new Set(parsed).size, '四类结局在线上被折并了——"分不清"这一类正是被折掉的那个').toBe(4)
    // 认不出的 kind 必须抛，而不是折成某一类。折成 indeterminate 看起来保守，实则把协议缺陷
    // 伪装成一次正常的不确定结局，于是没人会去修它。
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-bogus-outcome',
      ok: true,
      operation: 'browser.run',
      result: { logs: [], outcome: { kind: 'probably-fine' }, runOperation: operation }
    })).toThrow('outcome is invalid')
    // 带消息的三类缺了 message 也要抛：一条说不出原因的失败等于没说。
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-no-message',
      ok: true,
      operation: 'browser.run',
      result: { logs: [], outcome: { kind: 'stopped' }, runOperation: operation }
    })).toThrow('invalid')
  })

  // 日志是从另一个进程经 socket 过来的，而下游按 `string[]` 消费。不逐行校验的话，一份
  // `logs: [{}]` 会一路流进 UI 渲染成 "[object Object]"，或者在某个 `.split()` 上炸得离题万里。
  // 上限同理：这是线上解析器，对面不一定是我们自己的进程。
  it('validates browser.run logs line by line and caps how many it will take', () => {
    const operation = { id: 'op:test', browserId: 'browser:1', operator: { id: 'agent:test', name: 'Test Agent' }, startedAt: 1, phase: 'completed', summary: 'done', url: 'https://example.test/', steps: [] }
    const receipt = parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-logs',
      ok: true,
      operation: 'browser.run',
      result: { logs: ['one', 'two'], outcome: { kind: 'completed' }, runOperation: operation }
    })
    // 自检：合法的两行真的过了线，否则下面两条拒绝在对空气生效。
    expect(receipt.ok && receipt.operation === 'browser.run' && receipt.result.logs).toEqual(['one', 'two'])
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-bad-log-line',
      ok: true,
      operation: 'browser.run',
      result: { logs: ['fine', { message: 'not a string' }], outcome: { kind: 'completed' }, runOperation: operation }
    })).toThrow('Browser script log')
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-too-many-logs',
      ok: true,
      operation: 'browser.run',
      result: { logs: Array.from({ length: 10_001 }, () => 'x'), outcome: { kind: 'completed' }, runOperation: operation }
    })).toThrow('logs are invalid')
  })

  // 授权关闭时的拒绝要带自己的码。用 CONTROL_UNAVAILABLE 的话，Agent 会把"你没开这个开关"
  // 读成"这条路暂时不通"然后重试——重试一万次也不会通，要去改设置。
  it('carries BROWSER_AUTOMATION_DISABLED as its own code, not CONTROL_UNAVAILABLE', () => {
    const receipt = parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'run-disabled',
      ok: false,
      operation: 'browser.run',
      error: {
        code: 'BROWSER_AUTOMATION_DISABLED',
        message: 'Agent browser automation is off. Turn it on in Settings › Browser.'
      }
    })
    // 把这个码从 AGENTMUX_CONTROL_ERROR_CODES 删掉，controlErrorCode 会把它折成 CONTROL_FAILED，
    // 这条当场转红——与 REGION_ALREADY_SOLE 那条同一个判据形状。
    expect(receipt).toMatchObject({ ok: false, error: { code: 'BROWSER_AUTOMATION_DISABLED' } })
    // 拒绝必须说清怎么开。只判码不判文案的话，一句 "Not allowed." 也能绿，而 Agent 就卡在那了。
    expect(
      !receipt.ok && receipt.error.message,
      '拒绝没有指明去哪开——Agent 收到一句无法行动的拒绝'
    ).toContain('Settings')
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
    // 操作会占满 `AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS` 那档长预算），control-host 与
    // union-membership 同跑全绿——当时是 40 条，那个数只是那次测量的快照，不是今天的总数。
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
      interrupt: 'short',
      // browser.run 等的是子进程里一段 Agent 现写的程序跑完，那是本表最典型的"等外面"：它会等页面
      // 加载、等网络空闲、循环点很多次。两秒会把正常执行掐成 CONTROL_TIMEOUT。
      'browser.run': 'long',
      // history 只是把 journal 已经在内存里的那份记录读出来（store 那条臂上只有一次
      // listOperationHistory，不碰页面、不等子进程），所以它跟 list.agents 同档。
      'browser.history': 'short',
      // replay 会把录下来的步骤真的重放到页面上——它就是一次 browser.run，只是程序是我们生成的。
      // 给短预算等于把一次正常回放掐成 CONTROL_TIMEOUT，而此时页面上已经点过几下了。
      'browser.replay': 'long',
      // stop 只发一次 abort 就返回，**不等被取消的那个操作真的收尾**。这条是判过的：等它就等于把
      // 「停一个卡住的程序」变成「跟着那个程序一起卡住」，而卡住恰恰是最需要取消的场景。
      // 注意它与本表上面那个 session 的 `stop: 'long'` 不同档，两者不是同一件事：那条要等进程收尾。
      'browser.stop': 'short',
      // 读一条 journal 记录，与 history 同档。
      'browser.operation': 'short',
      // subscribe 的**开场帧**只读本地状态（那条操作在不在、有没有缺口），所以短档。这个预算管不到
      // 流本身：流的存活由长连接路径自己管，socket 上没有"请求超时"可言——一个操作安静十分钟是正常的。
      // 给长档等于让一次只读本地状态的问答白等一分钟。
      'browser.subscribe': 'short'
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
    // 长操作全部退化成 2 秒（`amux open.agent` 起一个 Agent 必然超时），而这一族全绿——
    // 我实测过两次，都存活。短常量只在**读到请求之前**那一处才是对的。
    // 刻意不写行号：行号会随上游漂。这段注释上一版举的那两个号码写下时就已失准，其中一个指的恰恰是
    // 短常量那一处——与本段论述正好相反。按「哪一处、用的哪个表达式」来指认，读者 grep 得到，也不会过期。
    const delays = [...hostSource.matchAll(/\.setTimeout\(\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/g)]
      .map((match) => match[1]!)
    // 判据是「调的是那一处取值函数、且参数是某个请求对象的 operation」，**不是某个局部变量叫什么名字**。
    // 此前这里钉死的是字面量 `agentMuxControlTimeoutMs(request.operation)`，于是一个把请求存进
    // `parsed` 的新调用点（订阅那条路径就是）会被判成"第三种写法"——而它恰恰是正确的那种写法。
    // 名字不是判据；同时这条正则仍然拦得住真正该拦的两样：写死某个操作字面量
    // （`agentMuxControlTimeoutMs('inspect.tab')` 不匹配 `\w+\.operation`），以及自己算一遍。
    const PER_OPERATION = /^agentMuxControlTimeoutMs\([A-Za-z_$][\w$]*\.operation\)$/
    const PRE_PARSE = 'AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS'

    // 恰好一处可以用短常量：还没读到请求，不知道是哪个操作，只能按短预算等第一条消息。
    expect(
      delays.filter((delay) => delay === PRE_PARSE),
      `用短常量当延时的 setTimeout 应当恰好一处（读到请求之前那一处）；实际：${delays.join(' | ')}`
    ).toHaveLength(1)
    // 其余每一处都必须按操作取值。少一处就有一条路把长操作按 2 秒等。
    const perOperation = delays.filter((delay) => PER_OPERATION.test(delay))
    expect(
      perOperation.length,
      `按操作取预算的 setTimeout 少于两处（读到请求后重排、以及客户端侧发起）；实际：${delays.join(' | ')}`
    ).toBeGreaterThanOrEqual(2)
    // 且没有第三种写法——谁想自己算一遍，那个表达式会落在这里。
    expect(
      delays.filter((delay) => delay !== PRE_PARSE && !PER_OPERATION.test(delay)),
      '有 setTimeout 的延时位既不是那一处短常量、也不是按操作取值'
    ).toEqual([])

    // 自检：抽取器真的找到了那些调用点，否则上面几条按数量判的会恒真。
    expect(delays.length, 'setTimeout 延时位抽取器一个都没找到，上面那几条守卫是死代码').toBeGreaterThanOrEqual(3)
    // 自检：抽取器认得出「自己算一遍」的那种拼法。
    const historical = `socket.setTimeout(longOperation(request.operation) ? LONG : SHORT, () => socket.destroy())`
    const probed = [...historical.matchAll(/\.setTimeout\(\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/g)].map((m) => m[1]!)
    expect(probed, '抽取器认不出内联算一遍的形状，那条守卫是死代码').toEqual(['longOperation(request.operation)'])
    // 自检：放宽成正则之后仍然拦得住写死操作字面量的那种——否则上面那条"没有第三种写法"就是空的。
    expect(PER_OPERATION.test("agentMuxControlTimeoutMs('inspect.tab')"), '正则放得太宽：写死操作字面量也算按操作取值了').toBe(false)
    expect(PER_OPERATION.test('agentMuxControlTimeoutMs(parsed.operation)'), '正则收得太紧：换个变量名的正确写法被判成第三种').toBe(true)
  })
})

describe('Browser 进度订阅：一问多答是独立的一支，一问一答那条不许被放宽', () => {
  const operationFact = (phase: string): AgentMuxControlBrowserOperation => ({
    id: 'op-stream',
    browserId: 'b1',
    operator: { id: 'agent-1', name: 'Agent 1' },
    startedAt: 1,
    phase,
    summary: 'streaming',
    url: 'https://example.invalid/',
    steps: []
  })

  /**
   * 订阅用的宿主替身。`emit` 交回给测试，所以事件是**测试驱动的**——不是让替身自己按固定脚本发几条。
   * 后者会让「只在终局发一条」这颗变异活下来：替身照旧发三条，而生产代码改成只转发最后一条时，
   * 断言看到的仍然是替身发的那三条里的某一条数量……除非计数钉死。这里让测试自己控制发几条，
   * 生产代码少转发一条当场可见。
   */
  const streamingHost = (options: {
    gap?: { droppedThrough: number } | null
    runOperation?: AgentMuxControlBrowserOperation | null
    onSubscribe?: (request: { operationId: string; afterSequence?: number }) => void
    fail?: Error
  } = {}): {
    readonly disposals: number
    emit(event: AgentMuxControlBrowserEvent): void
    host: {
      execute(): Promise<AgentMuxControlResult>
      subscribeBrowserOperation(
        request: { operationId: string; afterSequence?: number },
        onEvent: (event: AgentMuxControlBrowserEvent) => void
      ): Promise<{ runOperation: AgentMuxControlBrowserOperation | null; gap: { droppedThrough: number } | null; dispose(): void }>
    }
  } => {
    let emit: ((event: AgentMuxControlBrowserEvent) => void) | null = null
    let disposals = 0
    return {
      get disposals(): number { return disposals },
      emit(event: AgentMuxControlBrowserEvent): void { emit?.(event) },
      host: {
        async execute(): Promise<AgentMuxControlResult> { throw new Error('must not be reached in a subscribe test') },
        async subscribeBrowserOperation(request: { operationId: string; afterSequence?: number }, onEvent: (event: AgentMuxControlBrowserEvent) => void) {
          options.onSubscribe?.(request)
          if (options.fail) throw options.fail
          emit = onEvent
          return {
            runOperation: options.runOperation === undefined ? operationFact('running') : options.runOperation,
            gap: options.gap ?? null,
            dispose(): void { disposals += 1 }
          }
        }
      }
    }
  }

  // 形参用真的 `AgentMuxControlHost`，**不用 `as never`**：那个 cast 会让替身的形状与真接口脱钩，
  // 于是 subscribe 的签名改了（多一个参数、换个返回形状）之后这些测试照旧编译通过、照旧全绿，
  // 而生产代码那边已经对不上了。判据要靠 tsc 钉住，不是靠 cast 绕开。
  const serve = async (host: AgentMuxControlHost): Promise<{ server: AgentMuxControlServer; path: string }> => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-subscribe-'))
    roots.push(root)
    const path = join(root, 'control.sock')
    const server = new AgentMuxControlServer(host, path)
    await server.start()
    return { server, path }
  }

  it('流出按序的多条事件，不是只在终局来一条', async () => {
    const fake = streamingHost()
    const { server, path } = await serve(fake.host)
    const received: AgentMuxControlBrowserEvent[] = []
    let ended: string | null = null
    const opened = await subscribeAgentMuxControl(
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'sub-many', operation: 'browser.subscribe', operationId: 'op-stream' },
      { onEvent: (event) => received.push(event), onEnd: (reason) => { ended = reason } },
      path
    )
    // 开场帧先到，且它就是"在跑"那一档——早给的这一帧不许谎称已完成。
    expect(opened.runOperation?.phase, '开场帧把一个在跑的操作说成了别的档').toBe('running')
    expect(opened.gap, '没有缺口时不许编一个出来').toBeNull()

    fake.emit({ sequence: 1, event: { type: 'operation-started' } })
    fake.emit({ sequence: 2, event: { type: 'step-started', index: 0 } })
    fake.emit({ sequence: 3, event: { type: 'step-finished', index: 0 } })
    fake.emit({ sequence: 4, event: { type: 'operation-finished' } })
    await new Promise((resolve) => setTimeout(resolve, 60))

    // **整条钉死**而不是 `toBeGreaterThan(0)`：后者放过的正是"其实还是一问一答"这个缺陷——
    // 只转发最后一条时它照旧是 1 > 0。也不写 `every`：空集合上 every 恒真（本仓的白绿一族）。
    expect(received.map(({ sequence }) => sequence), '事件没有按序全部流出来（只在终局发一条的实现会在这里掉到 1 条）').toEqual([1, 2, 3, 4])
    expect(received.map(({ event }) => (event as { type: string }).type), '事件内容被改写了').toEqual([
      'operation-started', 'step-started', 'step-finished', 'operation-finished'
    ])
    expect(ended, '流还开着的时候就报了结束').toBeNull()

    opened.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(fake.disposals, '客户端退订之后承载方那侧的订阅没被清掉——它会继续往一条死 socket 写').toBe(1)
    await server.stop()
  })

  it('一问一答那条路径没被放宽：读一条→回一条→关闭，尾随数据仍被拒', async () => {
    // 这一条守的是本 task 最大的回归面。用**普通操作**（send）在同一个 server 上验证，因为放宽
    // `readMessage` 的后果落在所有 14 个操作上，不只是 Browser 那几条。
    const root = await mkdtemp(join(tmpdir(), 'agentmux-subscribe-framing-'))
    roots.push(root)
    const path = join(root, 'control.sock')
    let executions = 0
    const server = new AgentMuxControlServer({
      async execute(request): Promise<AgentMuxControlResult> {
        executions += 1
        if (request.operation !== 'send') throw new Error('Unexpected operation')
        return { operation: request.operation, agentSessionId: 'semantic-1' }
      }
    }, path)
    await server.start()

    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'framing', operation: 'send' as const, target: { kind: 'tab' as const, tabId: 'tab-main' }, text: 'one' }
    // 一条连接上塞两条请求：第二条是尾随数据，必须被拒，而且**execute 一次都不许跑**——放宽检查的
    // 实现会把第一条执行掉（甚至两条都执行），这里的计数当场变。
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path)
      let text = ''
      socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n${JSON.stringify({ ...request, requestId: 'framing-2' })}\n`))
      socket.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      socket.once('close', () => resolve(text))
      socket.once('error', reject)
    })
    const frames = raw.split('\n').filter((line) => line.trim())
    expect(frames.length, '一问一答那条路径回了不止一帧——framing 被放宽了').toBe(1)
    expect(JSON.parse(frames[0]!), '尾随数据没有被拒').toMatchObject({ ok: false, error: { code: 'CONTROL_PROTOCOL_ERROR' } })
    expect(executions, 'framing 检查该在执行之前就拒掉，它却已经把请求跑了').toBe(0)

    // 正常的一条仍然照旧：读一条→回一条→关闭。
    await expect(requestAgentMuxControl({ ...request, requestId: 'framing-ok' }, path)).resolves.toMatchObject({ operation: 'send' })
    expect(executions, '正常请求反而没被执行').toBe(1)
    await server.stop()
  })

  it('事件缺口在开场帧就说出来，不静默丢中段', async () => {
    const fake = streamingHost({ gap: { droppedThrough: 40 } })
    const { server, path } = await serve(fake.host)
    const opened = await subscribeAgentMuxControl(
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'sub-gap', operation: 'browser.subscribe', operationId: 'op-stream', afterSequence: 7 },
      { onEvent: () => {} },
      path
    )
    // 缺口必须是**显式的一个数**：客户端凭它知道 40 之前的事件已经不可得，可以改去读一次完整快照。
    // 静默丢弃的实现会在这里答 null，而它给出的流看起来连续、实际上少了中段。
    expect(opened.gap, '缺口被静默吞掉了：客户端会把一份不完整的时间线当成完整的').toEqual({ droppedThrough: 40 })
    await server.stop()
  })

  it('订阅建立失败：既不阻断（能力照在）也不静默（说得出哪一步没走通）', async () => {
    // 两侧都要守。只守"不阻断"会放过静默降级，只守"有说法"会放过把失败写成阻断。
    const fake = streamingHost({ fail: Object.assign(new Error('Progress journal is unavailable.'), { code: 'CONTROL_FAILED' }) })
    const { server, path } = await serve(fake.host)
    await expect(subscribeAgentMuxControl(
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'sub-fail', operation: 'browser.subscribe', operationId: 'op-stream' },
      { onEvent: () => {} },
      path
    // 明说：一条带码、带话的拒绝，而不是一条空流或一次静默成功。
    )).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: 'Progress journal is unavailable.' })

    // 同一个 server 随后仍然服务其余操作——订阅建立不成没有拿走任何既有能力（RED-LINES 第 2 类）。
    // 这里**不加 `as never`**：那个 cast 会把 execute 的形参一起推成 any（实测 TS7006），于是
    // `request.operation` 上的收窄消失——判据本身被 cast 掉了。宿主接口的 subscribe 是可选的，
    // 只给 execute 本来就合法。
    const working = new AgentMuxControlServer({
      async execute(request): Promise<AgentMuxControlResult> {
        if (request.operation !== 'browser.operation') throw new Error('Unexpected operation')
        return { operation: request.operation, runOperation: operationFact('completed') }
      }
    }, path)
    await server.stop()
    await working.start()
    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'still-works', operation: 'browser.operation', operationId: 'op-stream'
    }, path)).resolves.toMatchObject({ operation: 'browser.operation', result: { runOperation: { phase: 'completed' } } })
    await working.stop()
  })

  it('宿主不提供订阅时是一条类型化的能力协商答案，不是"暂时不可用"', async () => {
    // 判据钉在**码**上而不是"抛了就行"：`CONTROL_UNAVAILABLE` 会让 Agent 去重试，而这件事重试一万次
    // 也一样。折成那个码的实现在这里必须红。
    const { server, path } = await serve({
      async execute(): Promise<AgentMuxControlResult> { throw new Error('must not be reached') }
    })
    await expect(subscribeAgentMuxControl(
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'sub-unsupported', operation: 'browser.subscribe', operationId: 'op-stream' },
      { onEvent: () => {} },
      path
    )).rejects.toMatchObject({ code: 'BROWSER_SUBSCRIBE_UNSUPPORTED' })
    await server.stop()
  })

  it('查不到那条 id 时订阅是成功的：没有什么可流，但那不是 Browser 坏了', async () => {
    const fake = streamingHost({ runOperation: null })
    const { server, path } = await serve(fake.host)
    const opened = await subscribeAgentMuxControl(
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'sub-unknown', operation: 'browser.subscribe', operationId: 'op-nobody' },
      { onEvent: () => {} },
      path
    )
    expect(opened.runOperation, '查不到被报成了失败——那是 RED-LINES 第 2 类').toBeNull()
    expect(opened.gap, '查不到的操作不该带一个缺口').toBeNull()
    opened.dispose()
    await server.stop()
  })

  it('游标在协议入口就判，非法值不许穿到承载方', async () => {
    // 判在入口的理由：让 -1 穿过去的结果是承载方拿它做比较，于是"从头发"还是"什么都不发"取决于
    // 那边碰巧怎么写比较符——同一个非法输入在两个实现上两种行为。
    const seen: Array<number | undefined> = []
    const fake = streamingHost({ onSubscribe: (request) => seen.push(request.afterSequence) })
    const { server, path } = await serve(fake.host)
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(subscribeAgentMuxControl(
        { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'sub-cursor', operation: 'browser.subscribe', operationId: 'op-stream', afterSequence: bad },
        { onEvent: () => {} },
        path
      ), `afterSequence=${bad} 被放过了`).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    }
    // 0 是合法的（"从第一条开始"），别把它连坐进去。
    const opened = await subscribeAgentMuxControl(
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'sub-zero', operation: 'browser.subscribe', operationId: 'op-stream', afterSequence: 0 },
      { onEvent: () => {} },
      path
    )
    expect(seen, '非法游标穿到了承载方，或者合法的 0 被拒了').toEqual([0])
    opened.dispose()
    await server.stop()
  })
})
