import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import type { AgentMuxMessageEnvelope } from '../src/agent-global-message-queue.js'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import {
  AgentMuxControlServer,
  parseAgentMuxControlReceipt,
  parseAgentMuxControlRequest,
  connectAgentMuxRpc,
  AGENTMUX_RPC_CONTROL_METHODS,
  AgentMuxRpcLines,
  type AgentMuxRpcStreamInitial,
  type AgentMuxRpcFrame
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

function localMessage(body: string, recipient = 'semantic-1'): AgentMuxMessageEnvelope {
  return { schema: 'agentmux.a2a.v1', messageId: 'test-message', operationId: 'test-operation', createdAt: 1,
    sender: { kind: 'human', principal: 'local-cli' }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: null, senderRunId: null, recipientSessionId: recipient, recipientRunId: null,
    threadId: 'test-thread', correlationId: 'test-correlation', replyTo: null, workspaceId: null, body }
}

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
async function publicClient(path: string) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  cleanups.push(() => client.dispose())
  return client
}
async function coreOwner() {
  const owner = await rpcOwnerFixture(['semantic-1'])
  cleanups.push(owner.close)
  return owner
}
function activeAgent(owner: Awaited<ReturnType<typeof coreOwner>>) {
  const session = owner.client.agentSession('semantic-1')
  return { agentSessionId: session.agentSessionId,
    promptCondition: { expectedRun: session.run, afterSubmissionId: null },
    projectId: null, projectName: null, workspacePath: session.workspacePath,
    providerId: session.providerId, executorId: session.executorId,
    processState: 'running' as const, status: 'active' as const, updatedAt: session.updatedAt }
}
const emptyCatalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }

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
      target: { kind: 'space', tabId: 'self' }, inputPolicy: 'preserve'
    })).toThrow('exact ID')
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'legacy',
      operation: 'context',
      caller: { agentSessionId: 'semantic-1' }
    })).toThrow('operation')
  })

  it('rejects a managed send without an envelope before delivery', () => {
    expect(() => parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'bare-send', operation: 'send',
      target: { kind: 'agent-session', agentSessionId: 'semantic-1' }, text: 'body', caller: { agentSessionId: 'caller', capability: 'capability' },
      promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null } })).toThrow('envelope')
  })

  it('binds an A2A sender to the managed caller and its explicit Control target', () => {
    const message = {
      schema: 'agentmux.a2a.v1', messageId: 'message-1', operationId: 'request-1', createdAt: 1,
      sender: { kind: 'agent-session', agentSessionId: 'caller' },
      recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
      senderSessionId: 'caller', senderRunId: null, recipientSessionId: 'recipient', recipientRunId: null,
      body: 'body'
    } as const
    expect(parseAgentMuxControlRequest({ promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null },  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'request-1', operation: 'send', target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: 'body', caller: { agentSessionId: 'caller', capability: 'capability' }, message })).toMatchObject({ message })
    expect(() => parseAgentMuxControlRequest({ promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null },  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'request-spoof', operation: 'send', target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: 'body', caller: { agentSessionId: 'caller' }, message })).toThrow('sender')
    expect(() => parseAgentMuxControlRequest({ promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null },  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'request-2', operation: 'send', target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: 'body', caller: { agentSessionId: 'other' }, message })).toThrow('sender')
    expect(() => parseAgentMuxControlRequest({ promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null },  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'request-3', operation: 'send', target: { kind: 'agent-session', agentSessionId: 'other' }, text: 'body', caller: { agentSessionId: 'caller', capability: 'capability' }, message })).toThrow('recipient')
  })

  it('keeps open content and destinations as closed discriminated unions', () => {
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'open-right',
      operation: 'agent.open',
      caller: { agentSessionId: 'semantic-1' },
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'Review' },
      destination: { regionId: 'agent-left', split: 'right' }, focus: false
    })).toMatchObject({ operation: 'agent.open', destination: { regionId: 'agent-left', split: 'right' } })
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'invalid-destination',
      operation: 'agent.open',
      content: { kind: 'new-agent', executorId: 'codex' },
      destination: { kind: 'recent' }
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
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
    const { operation, ...focusResult } = focusFacts({ schemaVersion: 5, requestId: 'focus', operation: 'focus',
      target: { kind: 'space', tabId: 'tab' }, inputPolicy: 'preserve' })
    expect(() => parseAgentMuxControlReceipt({ ...success, operation, result: {
      ...focusResult, navigation: { ...focusResult.navigation, selection: { ...focusResult.navigation.selection,
        space: { ...focusResult.navigation.selection.space, tabId: 'self' } } }
    } })).toThrow('exact ID')
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
    const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/agentmux-control-probe-"))
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

  it('carries canonical public RPC through one real SDK and Unix owner endpoint', async () => {
    const core = await coreOwner()
    const path = join(core.root, 'control.sock')
    const seen: string[] = []
    const server = new AgentMuxControlServer({ socketPath: path, coreClients: core.coreClients,
      async execute(request): Promise<AgentMuxControlResult> {
        seen.push(request.operation)
        if (request.operation === 'inspect.tab') return { operation: request.operation,
          tab: { tabId: 'tab-main', workspaceId: 'workspace', regions: [
            { ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors }
          ] } }
        if (request.operation === 'space.inspect') return { operation: request.operation, catalog: emptyCatalog }
        if (request.operation === 'agent.open') return { operation: request.operation, requestId: request.requestId,
          outcome: 'opened', from: null, to: { spaceId: 'space', zoneId: 'zone', workspaceId: 'workspace', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab-main', regionId: 'agent-left' },
          agent: { agentSessionId: 'semantic-1', runId: 'run', providerId: 'codex', executorId: 'codex', hostId: 'local', cwd: upstreamFixturePath("repo"), createOperationId: 'creation', initialPrompt: 'not-requested' },
          resource: null, save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }, issues: [] }
        if (request.operation === 'list.active-agents') return { operation: request.operation, agents: [activeAgent(core)] }
        if (request.operation === 'send') {
          expect(request.message).toMatchObject({ body: request.text, recipientSessionId: 'semantic-1', recipientRunId: 'run-semantic-1' })
          if (request.text === 'invalid candidates') throw Object.assign(new Error('Invalid candidates'), {
            code: 'MESSAGE_TARGET_NOT_UNIQUE', candidates: [{ agentSessionId: '', regionIds: [] }]
          })
          return { operation: request.operation, agentSessionId: 'semantic-1' }
        }
        throw new Error('Unexpected operation')
      }
    })
    await server.start(); cleanups.push(() => server.stop())
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const client = await publicClient(path)
    await expect(client.call('space.inspect', { target: { tabId: 'tab-main' } }))
      .resolves.toMatchObject({ presentation: { tab: { tabId: 'tab-main' }, unavailable: [] } })
    await expect(client.call('agent.open', { operationId: 'open-agent', content: { kind: 'new-agent', executorId: 'codex' },
      destination: { regionId: 'agent-left', split: 'right' }, focus: false }))
      .resolves.toMatchObject({ operationId: 'open-agent', to: { tabId: 'tab-main' }, outcome: 'opened' })
    await expect(client.call('agent.send', { operationId: 'send', target: { kind: 'tab', tabId: 'tab-main' }, text: 'Continue' }))
      .resolves.toMatchObject({ agentSessionId: 'semantic-1', delivery: { state: 'delivered' } })
    await expect(client.call('agent.send', { operationId: 'invalid-candidates', target: { kind: 'tab', tabId: 'tab-main' }, text: 'invalid candidates' }))
      .rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(seen).toEqual(['inspect.tab', 'space.inspect', 'agent.open', 'inspect.tab', 'list.active-agents', 'send',
      'inspect.tab', 'list.active-agents', 'send'])
    expect(core.inner.kernel.stop).not.toHaveBeenCalled()
  })

  it('decodes UTF-8 only after arbitrary socket chunks are joined', async () => {
    const core = await coreOwner(), path = join(core.root, 'control.sock')
    let seen = ''
    const server = new AgentMuxControlServer({ socketPath: path, coreClients: core.coreClients,
      async execute(request): Promise<AgentMuxControlResult> {
        if (request.operation === 'list.active-agents') return { operation: request.operation, agents: [activeAgent(core)] }
        if (request.operation !== 'send') throw new Error('Unexpected operation')
        seen = request.text
        return { operation: request.operation, agentSessionId: 'semantic-1' }
      }
    })
    await server.start(); cleanups.push(() => server.stop())
    const request = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'utf8-send', method: 'agent.send', params: {
      operationId: 'utf8-send', target: { kind: 'agent-session', agentSessionId: 'semantic-1' }, text: '继续检查'
    } }) + '\n')
    const cut = request.indexOf(Buffer.from('继')) + 1
    expect(cut).toBeGreaterThan(0)
    const response = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(path), lines = new AgentMuxRpcLines()
      socket.once('connect', () => { socket.write(request.subarray(0, cut)); setImmediate(() => socket.write(request.subarray(cut))) })
      socket.on('data', chunk => { try { lines.accept(chunk, value => { socket.destroy(); resolve(value) }) } catch (error) { socket.destroy(); reject(error) } })
      socket.once('error', reject)
    })
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 'utf8-send', result: { delivery: { state: 'delivered' } } })
    expect(seen).toBe('继续检查')
    expect(core.inner.kernel.stop).not.toHaveBeenCalled()
  })

  it.each(['wire ID', 'legacy operation field'] as const)('rejects an error response with a mismatched %s', async identity => {
    const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-control-correlation-")); roots.push(root)
    const path = join(root, 'control.sock')
    const server = createServer(socket => {
      const lines = new AgentMuxRpcLines()
      socket.on('data', chunk => lines.accept(chunk, value => {
        const request = value as { id: string }
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: identity === 'wire ID' ? 'another-request' : request.id,
          ...(identity === 'legacy operation field' ? { operation: 'stop' } : {}),
          error: { code: -32000, message: 'Another request failed.', data: { code: 'REGION_NOT_OPEN' } }
        }) + '\n')
      }))
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const client = await publicClient(path)
    await expect(client.call('browser.inspect', { operationId: 'expected-operation' }))
      .rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  })
})

/**
 * 等待预算与「哪些操作算慢」都只有一处。
 *
 * 同一条 `agentmux agent open` 有两条到达执行方的路，各有一个等待方：这里的 CLI→daemon socket，以及
 * Renderer 拥有屏幕时 main→Renderer 的 IPC 桥（apps/desktop 的 control-ipc-bridge）。此前两侧各手抄
 * `2_000` / `60_000`，而**「哪些操作算慢」在这边是命名函数 `longOperation`、在桥那边被内联展开成同样
 * 的四项析取**。后果：加一个慢操作时只改一侧的人会得到一个全绿的仓库，而另一条路静默给它 2 秒——
 * 用户看到的是「同一个命令有时能开出来、有时报 CONTROL_TIMEOUT」，差别只在当时是谁拥有屏幕。
 *
 * 取值与语义归 core（本文件钉），「桥有没有真的从这一处取」归 desktop 那侧的守卫钉。
 */
describe('Control 等待预算与慢操作判据只有一处', () => {

  it('长操作等长预算、短操作等短预算', () => {
    expect(agentMuxControlTimeoutMs('agent.open')).toBe(AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS)
    expect(agentMuxControlTimeoutMs('inspect.tab')).toBe(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
    // 自检：两个预算相等时上面两条恒真，整族退化成装饰。
    expect(
      AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS,
      '长短预算相等，这一族分辨不出任何东西'
    ).toBeGreaterThan(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
  })

  it('按操作语义穷尽分配等待预算，持久化写入沿用长档', () => {
    // 等进程、composer、Provider 或持久化写入完成用长档；只读、布局和信号用短档。
    // 到期说明未及时得到完整回复，不证明 owner 已坏或写入未提交。
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
      'toolkit.add': 'long', 'toolkit.update': 'long', 'toolkit.remove': 'long',
      'toolkit.list': 'short', 'toolkit.get': 'short', 'toolkit.script': 'short',
      'toolkit.run': 'long', 'toolkit.action': 'long', 'toolkit.stop': 'long', 'toolkit.watch': 'short',
      'metrics.get': 'short', 'metrics.watch': 'short',
      'open.file': 'long', 'agent.view': 'long', 'space.view': 'long', 'space.swap': 'long',
      'agent.rename': 'long', 'agent.inspect': 'short', 'space.rename': 'long',
      'space.bind': 'long', 'space.unbind': 'long',
      'browser.task.assets': 'short', 'browser.task.reliability': 'short',
      'browser.task.run': 'long', 'browser.task.stop': 'short',
      'agent.open': 'long',
      'space.mv': 'long',
      'space.ls': 'short',
      'space.inspect': 'short',
      'open.terminal': 'long',
      'open.browser': 'long',
      // Refresh checks the saved executable on the selected host; it waits for that probe.
      'settings.executors.refresh': 'long',
      send: 'long',
      resume: 'long',
      stop: 'long',
      // 只读、本地布局与信号通常用短档；持久化写入另需长档。
      'inspect.client': 'short',
      'inspect.tab': 'short',
      'inspect.region': 'short',
      focus: 'short',
      arrange: 'short',
      // promote 只在本地布局树上搬一片叶子，不碰 Runtime lifecycle（见 store 的 promote.region 臂：
      // 那条路径上没有任何 api.sessions.* 调用），所以它和 arrange 同档。
      'promote.region': 'short',
      'list.agents': 'short',
      'list.projects': 'short',
      'list.active-agents': 'short',
      'settings.get': 'short',
      'diagnostics.crash-log.get': 'short',
      'diagnostics.crash-log.reveal': 'short',
      'settings.hosts.list': 'short',
      'settings.hosts.test': 'long',
      'settings.set': 'long',
      'settings.browser.links.list': 'short',
      'settings.browser.links.forget': 'long',
      'settings.workspaces.add': 'long',
      'settings.resource.list': 'short',
      'settings.resource.get': 'short',
      'settings.resource.add': 'long',
      'settings.resource.update': 'long',
      'settings.resource.remove': 'long',
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
      , 'demand.list': 'short'
      , 'demand.show': 'short'
      , 'demand.create': 'short'
      , 'demand.update': 'short'
      , 'demand.assign': 'short'
      , 'demand.start': 'long'
      , 'demand.handoff': 'short'
      , 'demand.delete': 'short'
      , 'demand.link-session': 'short'
      , 'demand.link-project': 'short'
      , 'demand.decision-log': 'short'
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

  it('public RPC client and dispatcher use the existing owner budget for mapped methods', () => {
    const clientSource = readFileSync(new URL('../src/public-rpc-client.ts', import.meta.url), 'utf8')
    const wireSource = readFileSync(new URL('../src/public-rpc-wire.ts', import.meta.url), 'utf8')
    const serverSource = readFileSync(new URL('../src/public-rpc-server.ts', import.meta.url), 'utf8')
    const importShape = /import\s*\{[^}]*\bagentMuxControlTimeoutMs\b[^}]*\}\s*from\s*'\.\/control\.js'/
    for (const source of [clientSource, wireSource]) {
      expect(importShape.test(source)).toBe(true)
      expect(source).toContain('agentMuxControlTimeoutMs(AGENTMUX_RPC_CONTROL_METHODS[method')
    }
    // Native methods have their explicit manifest classification; mapped methods
    // must use the original DTO owner, never another prefix-based long predicate.
    const mapped = Object.entries(AGENTMUX_RPC_CONTROL_METHODS)
    expect(mapped.length).toBeGreaterThan(10)
    expect(mapped.map(([method, operation]) => [method, agentMuxControlTimeoutMs(operation)]))
      .toContainEqual(['agent.open', AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS])
    expect(mapped.map(([method, operation]) => [method, agentMuxControlTimeoutMs(operation)]))
      .toContainEqual(['browser.follow', AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS])
    // The socket only owns the pre-request deadline. Once decoded, the
    // dispatcher owns each method's handshake; a subscription has no idle timeout.
    const delays = [...serverSource.matchAll(/socket\.setTimeout\(([^,)]+)/g)].map(match => match[1]!.trim())
    expect(delays).toEqual(['AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS', '0'])
    expect(clientSource).toContain("timeout(method) + (this.endpoint.transport === 'ssh' ? SSH_STARTUP_BUDGET_MS : 0)")
    expect(wireSource).toContain('}, duration)')
    expect(importShape.test("import { agentMuxControlTimeoutMs } from './control.js'")).toBe(true)
  })
})

describe('Browser 公共 RPC 订阅：唯一 response 后按序 notification，普通请求仍独立关联', () => {
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
    const server = new AgentMuxControlServer({ ...host, coreClients: () => [], socketPath: path })
    await server.start(); cleanups.push(() => server.stop())
    return { server, path }
  }

  async function follow(path: string, params: { operationId: string; afterSequence?: number }, options: {
    onEvent(event: AgentMuxControlBrowserEvent): void
    onEnd?(error?: Error): void
    onFrame?(frame: AgentMuxRpcFrame): void
  }) {
    const client = await publicClient(path)
    let initial!: AgentMuxRpcStreamInitial<'browser.follow'>
    const subscription = await client.subscribe('browser.follow', params, {
      onInitial: value => { initial = value },
      onEvent: event => { if (event.type === 'progress') options.onEvent(event.data) },
      onEnd: options.onEnd, onFrame: options.onFrame
    })
    expect(subscription.subscriptionId).not.toBe('')
    return { ...initial, dispose: () => subscription.dispose() }
  }

  it('流出按序的多条事件，不是只在终局来一条', async () => {
    const fake = streamingHost(), { path } = await serve(fake.host)
    const received: AgentMuxControlBrowserEvent[] = [], frames: AgentMuxRpcFrame[] = []
    let ended: Error | undefined | null = null
    const opened = await follow(path, { operationId: 'op-stream' }, {
      onEvent: event => received.push(event), onEnd: reason => { ended = reason }, onFrame: frame => frames.push(frame)
    })
    expect(opened.runOperation?.phase).toBe('running')
    expect(opened.gap).toBeNull()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ jsonrpc: '2.0', result: { method: 'browser.follow', initial: { runOperation: { phase: 'running' } } } })

    fake.emit({ sequence: 1, event: { type: 'operation-started' } })
    fake.emit({ sequence: 2, event: { type: 'step-started', index: 0 } })
    fake.emit({ sequence: 3, event: { type: 'step-finished', index: 0 } })
    fake.emit({ sequence: 4, event: { type: 'operation-finished' } })
    await vi.waitFor(() => expect(received.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]))
    expect(received.map(({ event }) => (event as { type: string }).type)).toEqual([
      'operation-started', 'step-started', 'step-finished', 'operation-finished'
    ])
    expect(frames).toHaveLength(5)
    expect(frames.filter(frame => 'result' in frame)).toHaveLength(1)
    expect(frames.slice(1).map(frame => 'method' in frame ? frame.method : null))
      .toEqual(['system.subscription.event', 'system.subscription.event', 'system.subscription.event', 'system.subscription.event'])
    expect(ended).toBeNull()
    await opened.dispose()
    await vi.waitFor(() => expect(fake.disposals).toBe(1))
  })

  it('普通 RPC 每个 id 只回一次；合法多请求独立关联，非法 JSON 不到业务 owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-rpc-framing-')); roots.push(root)
    const path = join(root, 'control.sock')
    let executions = 0
    const server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [],
      async execute(request): Promise<AgentMuxControlResult> {
        executions += 1
        if (request.operation !== 'browser.operation') throw new Error('Unexpected operation')
        return { operation: request.operation, runOperation: operationFact('completed') }
      }
    })
    await server.start(); cleanups.push(() => server.stop())
    const invalid = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path); let text = ''
      socket.once('connect', () => socket.write('not-json\ntrailing-data\n'))
      socket.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      socket.once('close', () => resolve(text)); socket.once('error', reject)
    })
    const invalidFrames = invalid.split('\n').filter(line => line.trim())
    expect(invalidFrames).toHaveLength(1)
    expect(JSON.parse(invalidFrames[0]!)).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } })
    expect(executions).toBe(0)

    const request = { jsonrpc: '2.0', id: 'first', method: 'browser.inspect', params: { operationId: 'op-stream' } }
    const replies = await new Promise<Array<{ id: string; result: unknown }>>((resolve, reject) => {
      const socket = createConnection(path), lines = new AgentMuxRpcLines(), values: Array<{ id: string; result: unknown }> = []
      socket.once('connect', () => socket.write(JSON.stringify(request) + '\n' + JSON.stringify({ ...request, id: 'second' }) + '\n'))
      socket.on('data', chunk => { try { lines.accept(chunk, value => {
        values.push(value as { id: string; result: unknown })
        if (values.length === 2) { socket.destroy(); resolve(values) }
      }) } catch (error) { socket.destroy(); reject(error) } })
      socket.once('error', reject)
    })
    expect(replies.map(reply => reply.id).sort()).toEqual(['first', 'second'])
    expect(replies.map(reply => reply.result)).toEqual([
      { runOperation: operationFact('completed') }, { runOperation: operationFact('completed') }
    ])
    expect(executions).toBe(2)
    const client = await publicClient(path)
    await expect(client.call('browser.inspect', { operationId: 'op-stream' }))
      .resolves.toEqual({ runOperation: operationFact('completed') })
    expect(executions).toBe(3)
  })

  it('事件缺口在开场帧就说出来，不静默丢中段', async () => {
    const fake = streamingHost({ gap: { droppedThrough: 40 } }), { path } = await serve(fake.host)
    const opened = await follow(path, { operationId: 'op-stream', afterSequence: 7 }, { onEvent: () => {} })
    expect(opened.gap).toEqual({ droppedThrough: 40 })
    await opened.dispose()
  })

  it('订阅建立失败：既不阻断（能力照在）也不静默（说得出哪一步没走通）', async () => {
    const fake = streamingHost({ fail: Object.assign(new Error('Progress journal is unavailable.'), { code: 'CONTROL_FAILED' }) })
    const { server, path } = await serve({ ...fake.host, async execute(request): Promise<AgentMuxControlResult> {
      if (request.operation !== 'browser.operation') throw new Error('Unexpected operation')
      return { operation: request.operation, runOperation: operationFact('completed') }
    } })
    await expect(follow(path, { operationId: 'op-stream' }, { onEvent: () => {} }))
      .rejects.toMatchObject({ code: 'CONTROL_FAILED', message: 'Progress journal is unavailable.' })
    // Use the very same owner endpoint: a failed observer cannot retire or
    // replace the healthy service before another business operation proceeds.
    const client = await publicClient(path)
    await expect(client.call('browser.inspect', { operationId: 'op-stream' }))
      .resolves.toMatchObject({ runOperation: { phase: 'completed' } })
    await server.stop()
  })

  it('宿主不提供订阅时是一条类型化的能力协商答案，不是暂时不可用', async () => {
    const { path } = await serve({ async execute(): Promise<AgentMuxControlResult> { throw new Error('must not be reached') } })
    await expect(follow(path, { operationId: 'op-stream' }, { onEvent: () => {} }))
      .rejects.toMatchObject({ code: 'BROWSER_SUBSCRIBE_UNSUPPORTED' })
  })

  it('查不到那条 id 时订阅成功：没有什么可流，但那不是 Browser 坏了', async () => {
    const fake = streamingHost({ runOperation: null }), { path } = await serve(fake.host)
    const opened = await follow(path, { operationId: 'op-nobody' }, { onEvent: () => {} })
    expect(opened.runOperation).toBeNull(); expect(opened.gap).toBeNull()
    await opened.dispose()
  })

  it('游标在协议入口就判，非法值不许穿到承载方', async () => {
    const seen: Array<number | undefined> = []
    const fake = streamingHost({ onSubscribe: request => seen.push(request.afterSequence) }), { path } = await serve(fake.host)
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(follow(path, { operationId: 'op-stream', afterSequence: bad }, { onEvent: () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    }
    const opened = await follow(path, { operationId: 'op-stream', afterSequence: 0 }, { onEvent: () => {} })
    expect(seen).toEqual([0])
    await opened.dispose()
  })
})
