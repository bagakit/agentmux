import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildReplayScript } from '../src/main/browser-view-manager'
import { BROWSER_OPERATION_PHASES, narrowBrowserOperation } from '../src/shared/browser-operation'

/**
 * 回放脚本的判据。
 *
 * **必须有一条真的把脚本跑起来**：`toContain` 只能证明某段源码出现在输出里，证不了它在算什么。
 * 把闸门条件从 `matches.length !== expected.count` 改成 `matches.length < 0`（永远放行），
 * 纯文本判据全绿——这正是下面 `runReplayScript` 存在的理由。
 */

/**
 * 按 `browser-script-runner.ts` 注入页面函数的方式跑一遍生成的脚本：那些名字是 `AsyncFunction`
 * 的形参，不是全局。这里用同一种形状，所以脚本怎么被真执行器看待，这里就怎么被看待。
 */
async function runReplayScript(
  script: string,
  pageFunctions: Record<string, (...args: unknown[]) => unknown>
): Promise<unknown> {
  const names = Object.keys(pageFunctions)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction(...names, '"use strict";\n' + script)
  return await fn(...names.map((name) => pageFunctions[name]!))
}

describe('Browser semantic replay', () => {
  it('resolves targets by role/name/ordinal and checks page identity', () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-1',
      url: 'https://example.test/path',
      steps: [{ method: 'click', url: 'https://example.test/path', target: { role: 'button', name: 'Continue', ordinal: 1, count: 1 }, args: [] }]
    })
    expect(script).toContain('pageIdentity.url')
    expect(script).toContain('node.role === expected.role')
    expect(script).toContain('Replay target changed')
    expect(script).not.toContain('Input.dispatchMouseEvent')
  })

  it('执行时把同名同位的目标点在它该点的那个 ref 上', async () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-3',
      url: 'https://example.test/list',
      steps: [{ method: 'click', url: 'https://example.test/list', target: { role: 'button', name: 'Delete', ordinal: 2, count: 3 }, args: [] }]
    })
    const clicked: unknown[] = []
    await runReplayScript(script, {
      pageInfo: async () => ({ url: 'https://example.test/list' }),
      snapshot: async () => ({
        nodes: [
          { ref: '@e1', role: 'button', name: 'Delete' },
          { ref: '@e2', role: 'button', name: 'Delete' },
          { ref: '@e3', role: 'button', name: 'Delete' }
        ]
      }),
      click: async (ref: unknown) => {
        clicked.push(ref)
      }
    })
    expect(clicked).toEqual(['@e2'])
  })

  it('页面换了身份就一步都不做——闸门在第一个动作之前', async () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-4',
      url: 'https://example.test/list',
      steps: [{ method: 'click', url: 'https://example.test/list', target: { role: 'button', name: 'Delete', ordinal: 1, count: 1 }, args: [] }]
    })
    const clicked: unknown[] = []
    await expect(
      runReplayScript(script, {
        pageInfo: async () => ({ url: 'https://example.test/somewhere-else' }),
        snapshot: async () => ({ nodes: [{ ref: '@e1', role: 'button', name: 'Delete' }] }),
        click: async (ref: unknown) => {
          clicked.push(ref)
        }
      })
    ).rejects.toThrow(/page identity changed/i)
    expect(clicked).toEqual([])
  })

  it('目标不在了就抛，不退回去点一个同名的邻居', async () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-5',
      url: 'https://example.test/list',
      steps: [{ method: 'click', url: 'https://example.test/list', target: { role: 'button', name: 'Delete', ordinal: 2, count: 2 }, args: [] }]
    })
    const clicked: unknown[] = []
    await expect(
      runReplayScript(script, {
        pageInfo: async () => ({ url: 'https://example.test/list' }),
        // 只剩一个同名元素：录的是第 2 个，回放时它不存在了。
        snapshot: async () => ({ nodes: [{ ref: '@e1', role: 'button', name: 'Delete' }] }),
        click: async (ref: unknown) => {
          clicked.push(ref)
        }
      })
    ).rejects.toThrow(/Replay target changed/)
    expect(clicked).toEqual([])
  })

  it('同名元素的总数变了就抛——哪怕那个序号上确实还坐着一个元素', async () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-7',
      url: 'https://example.test/list',
      steps: [{ method: 'click', url: 'https://example.test/list', target: { role: 'button', name: 'Delete', ordinal: 2, count: 3 }, args: [] }]
    })
    const clicked: unknown[] = []
    await expect(
      runReplayScript(script, {
        pageInfo: async () => ({ url: 'https://example.test/list' }),
        // 录的时候有 3 个，现在只有 2 个。第 2 个**存在**，所以 `!targetNode` 拦不住这一条——
        // 只有总数判据能拦。把它写死成永远放行（`matches.length < 0`）必须让这条红。
        snapshot: async () => ({
          nodes: [
            { ref: '@e1', role: 'button', name: 'Delete' },
            { ref: '@e2', role: 'button', name: 'Delete' }
          ]
        }),
        click: async (ref: unknown) => {
          clicked.push(ref)
        }
      })
    ).rejects.toThrow(/Replay target changed/)
    expect(clicked).toEqual([])
  })

  it('keeps blocked sensitive steps blocked instead of embedding their value', () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-2',
      url: 'https://example.test/',
      steps: [{ method: 'fillInput', url: 'https://example.test/', args: ['@e1', 'secret-value'], blockedReason: 'Sensitive input is requested again at replay time.' }]
    })
    expect(script).toContain('Sensitive input is requested again')
    expect(script).not.toContain('secret-value')
  })

  it('被闸住的步骤在执行时也真的抛，不是只在源码里留一句话', async () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-6',
      url: 'https://example.test/',
      steps: [
        { method: 'fillInput', url: 'https://example.test/', args: ['@e1', 'secret-value'], blockedReason: 'Sensitive input is requested again at replay time.' },
        { method: 'click', url: 'https://example.test/', target: { role: 'button', name: 'Submit', ordinal: 1, count: 1 }, args: [] }
      ]
    })
    const called: string[] = []
    await expect(
      runReplayScript(script, {
        pageInfo: async () => {
          called.push('pageInfo')
          return { url: 'https://example.test/' }
        },
        snapshot: async () => {
          called.push('snapshot')
          return { nodes: [{ ref: '@e1', role: 'button', name: 'Submit' }] }
        },
        fillInput: async () => {
          called.push('fillInput')
        },
        click: async () => {
          called.push('click')
        }
      })
    ).rejects.toThrow(/Sensitive input is requested again/)
    // 闸门之后的 click 绝不能发生：跳过填值只回放两旁的动作，是提交一张空表单。
    expect(called).not.toContain('click')
    expect(called).not.toContain('fillInput')
  })

  it('不在页面函数名单里的 method 不许拼进脚本源码——挡了参数没挡动词等于没挡', async () => {
    // `buildReplayScript` 把 `step.method` **原样**拼进源码（`await ${step.method}(...)`），而同一个
    // 函数里 target/args 都走 JSON.stringify。method 的值来自子进程经 IPC 送回的页面调用名，而
    // Agent 的程序跑在带 IPC 的普通 Node 子进程里，自己 process.send 就能送进任意字符串；派发层
    // 的拒绝发生在 `startBrowserOperationStep` **之后**，所以那个名字已经进了日志，而持久化边界
    // 对 method 只 clamp 长度。
    //
    // 于是它能变成可执行语句，还能够到 `js`——正是 sanitizeReplay 特意用 blockedReason 挡住的逃生口。
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-injected',
      url: 'https://example.test/',
      steps: [{ method: "click('@e1'); await js('globalThis.__pwned = 1'); //", url: 'https://example.test/', args: [] }]
    })

    const called: string[] = []
    const js = async (...args: unknown[]): Promise<null> => { called.push(`js:${String(args[0])}`); return null }
    await expect(
      runReplayScript(script, {
        pageInfo: async () => ({ url: 'https://example.test/' }),
        snapshot: async () => ({ nodes: [{ ref: '@e1', role: 'button', name: 'Submit' }] }),
        click: async () => { called.push('click'); return null },
        js
      })
    ).rejects.toThrow(/not a replayable Browser page function/)
    // 承重的那一半：`js` 一次都不许被调到。只判"抛了"的话，先执行再抛也会全绿。
    expect(called, '注入的语句被执行了——挡了参数没挡动词').toEqual([])
  })

  it('名单里的正常动词照旧回放——闸门不许顺手把真实步骤也挡掉', async () => {
    // 反向那一半。只有上面那条的话，「一律抛」也会全绿，而那会让回放整个功能失效。
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-ok',
      url: 'https://example.test/',
      steps: [{ method: 'click', url: 'https://example.test/', args: [] }]
    })
    const called: string[] = []
    await expect(
      runReplayScript(script, {
        pageInfo: async () => ({ url: 'https://example.test/' }),
        snapshot: async () => ({ nodes: [{ ref: '@e1', role: 'button', name: 'Submit' }] }),
        click: async () => { called.push('click'); return null }
      })
    ).resolves.toMatchObject({ replayOf: 'op-ok' })
    expect(called, '正常的 click 被闸门挡掉了——回放功能整体失效').toEqual(['click'])
  })
})

/**
 * T-008 收口后的两条范围判据：**该收的收了、不该动的没动**，以及**两条路一套词汇**。
 *
 * 这两条都从源码反推（不维护手写清单），并且各自先证扫描有收获——扫到空内容时
 * `not.toContain` 与 `every` 全都恒真，那种绿比缺陷本身更难发现。
 */
describe('T-008 收口的范围与词汇', () => {
  const read = (relative: string): string =>
    readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8')

  it('停止/历史/回放不再有直连 IPC 的第二套语义调用点', () => {
    const pane = read('renderer/src/components/BrowserPane.tsx')
    expect(pane.length, 'BrowserPane 读不出来——下面的判据在对空串生效').toBeGreaterThan(1_000)
    // 只数**调用点**（`api.browser.x(`），不数字符串出现：注释里提到旧入口是刻意保留的（记着这次
    // 收口），按名字数会把那条注释判成违规。
    for (const symbol of ['stopOperation', 'listOperationHistory', 'replayPlan', 'runReplay']) {
      expect(pane, `BrowserPane 仍有 api.browser.${symbol}(...) 的直连调用——第二套语义还在`)
        .not.toContain(`api.browser.${symbol}(`)
    }
    // 反向那一半：它**确实**经协议了。缺这句的话，"把三条入口整个删掉"也会让上面全绿。
    const protocolCalls = [...pane.matchAll(/operation: 'browser\.(stop|history|replay)'/g)].map((match) => match[1])
    expect(new Set(protocolCalls), 'BrowserPane 没有经协议发这三条——上面的 not.toContain 是因为功能没了才绿的')
      .toEqual(new Set(['stop', 'history', 'replay']))
  })

  it('无关的本地控制仍走直连 IPC，没被这次收口顺手改道', () => {
    const pane = read('renderer/src/components/BrowserPane.tsx')
    // 视口、截图、DevTools、元素选择、交还控制都不是能力协议的一部分。它们被改道不会报错，只会让
    // 这一刀从"收口三条语义"变成一次大重构——这条守的正是范围蔓延。
    const localControls = ['setViewport', 'captureScreenshot', 'openDevTools', 'selectElement', 'returnControl']
    const missing = localControls.filter((symbol) => !pane.includes(`api.browser.${symbol}(`))
    expect(missing, `这些本地控制被改道了（或被删了）：${missing.join(', ')}`).toEqual([])
  })

  it('phase 词汇只有一处收窄点：协议的宽类型进 Desktop 只经过一个门', () => {
    const shared = read('shared/browser-operation.ts')
    expect(shared, 'phase 词表不在 shared 里了——收窄点搬走了').toContain('BROWSER_OPERATION_PHASES')
    // 词表必须与类型逐字一致。分开写两份时，加一档 phase 只改一处，另一处会把新档静默降成
    // indeterminate——而那看起来完全像是"这次真的不确定"。
    const declared = shared.slice(shared.indexOf('export type BrowserOperationPhase'))
    const typeEnd = declared.indexOf('\n')
    expect(typeEnd, 'BrowserOperationPhase 的声明行取不到').toBeGreaterThan(0)
    const fromType = [...declared.slice(0, typeEnd).matchAll(/'([a-z]+)'/g)].map((match) => match[1]!)
    // 锚在 `= [` 上，**不是** `[`：后者会先撞上 `readonly BrowserOperationPhase[]` 里那对空方括号，
    // 于是切出来的是空串，而空串上 `matchAll` 给空数组、两个空集相等——判据恒真。（实测踩过。）
    const listStart = shared.indexOf('BROWSER_OPERATION_PHASES')
    expect(listStart, 'BROWSER_OPERATION_PHASES 不在场').toBeGreaterThan(-1)
    const bodyStart = shared.indexOf('= [', listStart)
    expect(bodyStart, '词表的 `= [` 起锚点不在场——切出来会是空串或整段').toBeGreaterThan(listStart)
    const listBody = shared.slice(bodyStart, shared.indexOf(']', bodyStart))
    const fromList = [...listBody.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!)
    expect(fromType.length, '类型里一个 phase 都没捞到——下面的比对是两个空集').toBeGreaterThan(3)
    expect(fromList.length, '词表里一个 phase 都没捞到——下面的比对是两个空集').toBeGreaterThan(3)
    expect(fromList, 'phase 运行期清单与类型不一致——加一档时漏改了一处').toEqual(fromType)
  })

  it('收窄不把认不出的 phase 改成一个眼熟的档位', () => {
    const base = {
      id: 'op-1', browserId: 'b1', operator: { id: 'a1', name: 'A' },
      startedAt: 1, summary: 's', url: 'https://example.test/', steps: []
    }
    // 认不出来时只能是 indeterminate（"做到哪儿我们不知道"）。改成 completed/failed/running 都是
    // 在拿一个我们没有的事实冒充：前两个说事情结束了，第三个说它还在跑。
    expect(narrowBrowserOperation({ ...base, phase: 'something-we-do-not-know' }).phase,
      '认不出的 phase 被改成了一个眼熟的档位').toBe('indeterminate')
    // 另一半：认得出的照原样过。只判上面那句的话，"一律 indeterminate" 也会全绿——而那会让每条
    // 真实状态都退化成"不确定"。
    for (const phase of BROWSER_OPERATION_PHASES) {
      expect(narrowBrowserOperation({ ...base, phase }).phase, `认得出的 phase「${phase}」被改写了`).toBe(phase)
    }
    expect(BROWSER_OPERATION_PHASES.length, '词表是空的——上面那个循环一次都没跑').toBeGreaterThan(3)
  })
})
