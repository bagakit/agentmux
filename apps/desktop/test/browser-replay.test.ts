import { describe, expect, it } from 'vitest'
import { buildReplayScript } from '../src/main/browser-view-manager'

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
})
