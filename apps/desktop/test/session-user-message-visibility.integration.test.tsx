// @vitest-environment happy-dom
import { act, startTransition, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type {
  AgentSessionHistoryPage,
  AgentTimelineItem,
  AgentTimelineSnapshot
} from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { createSpeakerResolver } from '../src/renderer/src/lib/conversation-speaker'

/**
 * Notice on Controlled Public DTO:
 * This test uses controlled public AgentSessionHistoryPage DTOs to verify the shared
 * renderer hook (useSessionUserMessages) and ActivityView presentation contract.
 * It verifies the client message projection, pause/resume, DOM identity, Range preservation,
 * and multi-consumer lifecycle; it does not claim to prove vendor CLI writer behavior.
 */

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const controlA: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'session-t036-alpha',
  run: { runId: 'run-t036-alpha' }
}

const controlB: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'session-t036-beta',
  run: { runId: 'run-t036-beta' }
}

let host: HTMLDivElement
let root: Root
let historyPageSpy: MockInstance<typeof api.sessions.historyPage>
const baseline = useAppStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
  historyPageSpy?.mockRestore()
  useAppStore.setState(baseline, true)
})

function ActivityPresenter({
  control,
  enabled = true,
  items = [],
  onRender,
  passDownRef
}: {
  control?: AgentSessionControl
  enabled?: boolean
  items?: AgentTimelineItem[]
  onRender?: (info: { messagesCount: number; loading: boolean; error: Error | null }) => void
  passDownRef?: (callbacks: { refresh: () => Promise<void>; loadEarlier: () => Promise<void> }) => void
}) {
  const { messages, loading, error, refresh, loadEarlier } = useSessionUserMessages(control, { enabled })

  onRender?.({ messagesCount: messages.length, loading, error })
  passDownRef?.({ refresh, loadEarlier })

  const speakerResolver = createSpeakerResolver({
    currentSession: control ? { id: control.agentSessionId, label: 'Agent' } : undefined
  })

  return (
    <div data-testid="presenter-root" data-messages-count={messages.length} data-loading={loading ? 'true' : 'false'}>
      <ActivityView
        sessionId={control?.agentSessionId ?? 'default-session'}
        items={items}
        userMessages={messages}
        capability="complete-events"
        displayState="done"
        describeSpeaker={speakerResolver}
      />
    </div>
  )
}

describe('T036 共享消息读取与视图可见性集成测试', () => {
  it('证伪反例与核心不变式: 暂停读取 (enabled:false) 必须保持原Activity呈现正文DOM节点与选区Range', async () => {
    const identicalText = 'Identical prompt text across sources'

    const historyPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'native-rec-1',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: identicalText }],
          startedAt: 10_000
        },
        {
          id: 'native-rec-2',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: identicalText }],
          startedAt: 11_000
        }
      ],
      nextCursor: null
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(historyPage)

    const capturedTimelineItem: AgentTimelineItem = {
      id: 'captured-sub-1',
      agentSessionId: controlA.agentSessionId,
      kind: 'user_message',
      status: 'complete',
      source: 'user',
      title: 'Prompt',
      content: identicalText,
      createdAt: 12_000,
      updatedAt: 12_000
    }

    const timelineSnap: AgentTimelineSnapshot = {
      agentSessionId: controlA.agentSessionId,
      items: [capturedTimelineItem],
      revision: 1
    }

    useAppStore.setState({
      timelines: {
        [controlA.agentSessionId]: timelineSnap
      }
    })

    // 1. 初始挂载：enabled = true
    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={true} items={[capturedTimelineItem]} />)
    })

    const turnsBefore = host.querySelectorAll('.log-turn')
    expect(turnsBefore.length).toBe(3)

    const nativeBody = turnsBefore[0]?.querySelector('.log-turn__body') as HTMLDivElement | null
    expect(nativeBody, 'Native body element exists').not.toBeNull()
    expect(nativeBody!.textContent).toContain(identicalText)
    expect(nativeBody!.isConnected, 'nativeBody is connected to document').toBe(true)

    const range = document.createRange()
    range.selectNodeContents(nativeBody!)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(selection.rangeCount).toBe(1)
    expect(range.startContainer).toBe(nativeBody)

    // 2. 模拟 History 覆盖打开：enabled 设为 false (暂停读取，不产生新 I/O)
    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={false} items={[capturedTimelineItem]} />)
    })

    expect(nativeBody!.isConnected, 'nativeBody MUST remain connected to DOM after pausing reading').toBe(true)

    const turnsAfter = host.querySelectorAll('.log-turn')
    expect(turnsAfter.length, 'All 3 turns must remain rendered').toBe(3)

    const nativeBodyAfter = turnsAfter[0]?.querySelector('.log-turn__body')
    expect(nativeBodyAfter, 'Body node after pause must be identical node instance').toBe(nativeBody)

    expect(selection.rangeCount, 'Selection range count preserved').toBe(1)
    const currentRange = selection.getRangeAt(0)
    expect(currentRange.startContainer, 'Range startContainer preserved').toBe(nativeBody)
  })

  it('证伪 1: Registry projectedMessages 共享缺陷反例 - 另一 active 消费者 refresh 或父 rerender 时，paused 消费者私有投影与 Range 恒定', async () => {
    const pageInit: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'turn-init',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Original frozen message' }],
          startedAt: 10_000
        }
      ],
      nextCursor: null
    }

    const pageRefreshed: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'turn-refreshed',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Brand new refreshed message' }],
          startedAt: 20_000
        }
      ],
      nextCursor: null
    }

    let pageToReturn = pageInit
    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => pageToReturn)

    let consumer2Callbacks: { refresh: () => Promise<void> } | undefined

    function DualHost({ consumer1Enabled, parentTick }: { consumer1Enabled: boolean; parentTick: number }) {
      return (
        <div>
          <div data-testid="consumer-1-container" data-tick={parentTick}>
            <ActivityPresenter control={controlA} enabled={consumer1Enabled} />
          </div>
          <div data-testid="consumer-2-container">
            <ActivityPresenter
              control={controlA}
              enabled={true}
              passDownRef={(c) => {
                consumer2Callbacks = c
              }}
            />
          </div>
        </div>
      )
    }

    // 1. 两个消费者同时挂载，读取初始事实
    await act(async () => {
      root.render(<DualHost consumer1Enabled={true} parentTick={0} />)
    })

    const consumer1Container = host.querySelector('[data-testid="consumer-1-container"]')!
    const c1BodyBefore = consumer1Container.querySelector('.log-turn__body') as HTMLDivElement | null
    expect(c1BodyBefore).not.toBeNull()
    expect(c1BodyBefore!.textContent).toContain('Original frozen message')

    // 选区锁定在 Consumer 1 的正文上
    const range1 = document.createRange()
    range1.selectNodeContents(c1BodyBefore!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range1)

    // 2. Consumer 1 暂停 (例如覆屏)，Consumer 2 保持活跃
    await act(async () => {
      root.render(<DualHost consumer1Enabled={false} parentTick={1} />)
    })

    // 3. Consumer 2 执行 refresh，返回全新消息
    pageToReturn = pageRefreshed
    await act(async () => {
      await consumer2Callbacks!.refresh()
    })

    // Consumer 2 应该呈现新内容
    const consumer2Container = host.querySelector('[data-testid="consumer-2-container"]')!
    expect(consumer2Container.textContent).toContain('Brand new refreshed message')

    // 4. Consumer 1 经历父级 rerender (例如窗口/Tab焦点触发重绘)
    await act(async () => {
      root.render(<DualHost consumer1Enabled={false} parentTick={2} />)
    })

    // 断言证伪 1:
    // Consumer 1 绝不能因父 rerender 或全局 Registry.projectedMessages 共享而变成新内容！
    // 它的 DOM 节点、正文与 Range 选区必须完整保持！
    const c1BodyAfter = consumer1Container.querySelector('.log-turn__body')
    expect(c1BodyAfter, 'Consumer 1 body must be the identical original node').toBe(c1BodyBefore)
    expect(c1BodyAfter!.textContent).toContain('Original frozen message')
    expect(c1BodyAfter!.textContent).not.toContain('Brand new refreshed message')
    expect(c1BodyAfter!.isConnected).toBe(true)
    expect(sel.getRangeAt(0).startContainer).toBe(c1BodyBefore)
  })

  it('证伪 2: disabled 回调必须不产生 read，源失败暴露诚实 error 并保原正文', async () => {
    const historyPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'turn-steady',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Resilient stable body' }],
          startedAt: 10_000
        }
      ],
      nextCursor: 'cursor-page-2'
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(historyPage)

    let callbacks: { refresh: () => Promise<void>; loadEarlier: () => Promise<void> } | undefined
    let lastError: Error | null = null

    // 1. 活跃挂载加载内容
    await act(async () => {
      root.render(
        <ActivityPresenter
          control={controlA}
          enabled={true}
          passDownRef={(c) => {
            callbacks = c
          }}
          onRender={(info) => {
            lastError = info.error
          }}
        />
      )
    })

    expect(historyPageSpy).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Resilient stable body')

    // 2. 暂停 (enabled: false)
    await act(async () => {
      root.render(
        <ActivityPresenter
          control={controlA}
          enabled={false}
          passDownRef={(c) => {
            callbacks = c
          }}
          onRender={(info) => {
            lastError = info.error
          }}
        />
      )
    })

    // 3. 在 disabled 下触发 refresh 与 loadEarlier
    await act(async () => {
      await callbacks!.refresh()
      await callbacks!.loadEarlier()
    })

    // 断言证伪 2: disabled 回调绝不得发起网络 I/O
    expect(historyPageSpy, 'Disabled callbacks must produce ZERO reads').toHaveBeenCalledTimes(1)

    // 4. 恢复活跃并触发模拟网络失败的 refresh
    await act(async () => {
      root.render(
        <ActivityPresenter
          control={controlA}
          enabled={true}
          passDownRef={(c) => {
            callbacks = c
          }}
          onRender={(info) => {
            lastError = info.error
          }}
        />
      )
    })

    historyPageSpy.mockRejectedValueOnce(new Error('Network transport error'))
    await act(async () => {
      await callbacks!.refresh()
    })

    // 源错误必须诚实抛出 error，同时保住原有正文 DOM
    expect(lastError, 'Honest error must be exposed to caller').not.toBeNull()
    expect(lastError!.message).toBe('Network transport error')
    expect(host.textContent, 'Existing text must remain in DOM despite error').toContain('Resilient stable body')
  })

  it('证伪 4: History cover 与 Return pending 期间 native 与 captured 节点及选区均保，源成功诚实刷新', async () => {
    const identicalProse = 'Triple identical prompt text'

    const initPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'turn-native-1',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: identicalProse }],
          startedAt: 10_000
        },
        {
          id: 'turn-native-2',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: identicalProse }],
          startedAt: 11_000
        }
      ],
      nextCursor: null
    }

    let resolvePendingPage!: (page: AgentSessionHistoryPage) => void
    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(initPage)

    const capturedItem: AgentTimelineItem = {
      id: 'captured-turn-3',
      agentSessionId: controlA.agentSessionId,
      kind: 'user_message',
      status: 'complete',
      source: 'user',
      title: 'Prompt',
      content: identicalProse,
      createdAt: 12_000,
      updatedAt: 12_000
    }

    useAppStore.setState({
      timelines: {
        [controlA.agentSessionId]: {
          agentSessionId: controlA.agentSessionId,
          items: [capturedItem],
          revision: 1
        }
      }
    })

    // 1. 活跃渲染全部三条 (native 1, native 2, captured 3)
    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={true} items={[capturedItem]} />)
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns.length).toBe(3)

    const native1Body = turns[0]?.querySelector('.log-turn__body') as HTMLDivElement | null
    const native2Body = turns[1]?.querySelector('.log-turn__body') as HTMLDivElement | null
    const captured3Body = turns[2]?.querySelector('.log-turn__body') as HTMLDivElement | null

    expect(native1Body).not.toBeNull()
    expect(native2Body).not.toBeNull()
    expect(captured3Body).not.toBeNull()

    // 设置选区在 native1
    const range = document.createRange()
    range.selectNodeContents(native1Body!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    // 2. 打开 History 覆盖层 (enabled: false)
    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={false} items={[capturedItem]} />)
    })

    // 暂停期间：native 与 captured 节点及选区均保持
    expect(native1Body!.isConnected, 'native1Body connected during pause').toBe(true)
    expect(native2Body!.isConnected, 'native2Body connected during pause').toBe(true)
    expect(captured3Body!.isConnected, 'captured3Body connected during pause').toBe(true)
    expect(sel.getRangeAt(0).startContainer).toBe(native1Body)

    // 3. 点击 Return (enabled: true)，但此时触发的重新验证请求处于 in-flight pending 状态
    const pendingPromise = new Promise<AgentSessionHistoryPage>((resolve) => {
      resolvePendingPage = resolve
    })
    historyPageSpy.mockReturnValue(pendingPromise)

    let callbacks: { refresh: () => Promise<void> } | undefined
    await act(async () => {
      root.render(
        <ActivityPresenter
          control={controlA}
          enabled={true}
          items={[capturedItem]}
          passDownRef={(c) => {
            callbacks = c
          }}
        />
      )
    })

    // 显式触发一次 refresh 产生 pending in-flight
    await act(async () => {
      void callbacks?.refresh()
    })

    // 断言证伪 4：在 Return pending 期间，绝对不得将现有正文冲掉或用 captured-only fallback 替换
    const turnsPending = host.querySelectorAll('.log-turn')
    expect(turnsPending.length, 'All 3 turns must remain present during pending Return').toBe(3)
    const currentNative1 = turnsPending[0]?.querySelector('.log-turn__body')
    const currentCaptured3 = turnsPending[2]?.querySelector('.log-turn__body')
    expect(currentNative1, 'native1Body must be preserved during pending Return').toBe(native1Body)
    expect(currentCaptured3, 'captured3Body must be preserved during pending Return').toBe(captured3Body)
    expect(sel.getRangeAt(0).startContainer).toBe(native1Body)

    // 4. 源数据最终成功返回更新
    await act(async () => {
      resolvePendingPage({
        agentSessionId: controlA.agentSessionId,
        source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
        items: [
          {
            id: 'turn-native-1',
            kind: 'user-message',
            contentParts: [{ kind: 'text', text: 'Refreshed native text' }],
            startedAt: 10_000
          }
        ],
        nextCursor: null
      })
    })

    // 最终诚实刷新呈现
    expect(host.textContent).toContain('Refreshed native text')
  })

  it('复显语义 (resume): 从暂停恢复为 enabled:true 保持同一节点，不产生重复网络请求', async () => {
    const historyPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'turn-alpha',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Resume prompt text' }],
          startedAt: 10_000
        }
      ],
      nextCursor: null
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(historyPage)

    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={true} />)
    })

    expect(historyPageSpy).toHaveBeenCalledTimes(1)
    const bodyBefore = host.querySelector('.log-turn__body')
    expect(bodyBefore?.isConnected).toBe(true)

    // 暂停
    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={false} />)
    })
    expect(bodyBefore?.isConnected).toBe(true)

    // 恢复
    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={true} />)
    })

    const bodyAfterResume = host.querySelector('.log-turn__body')
    expect(bodyAfterResume).toBe(bodyBefore)
    expect(historyPageSpy).toHaveBeenCalledTimes(1)
  })

  it('晚到结果不刷新已暂停者: 请求在途时暂停，晚到结果不刷新已暂停视图', async () => {
    let resolveHistoryPage!: (page: AgentSessionHistoryPage) => void
    const pendingPromise = new Promise<AgentSessionHistoryPage>((resolve) => {
      resolveHistoryPage = resolve
    })

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockReturnValue(pendingPromise)

    let renderCount = 0
    await act(async () => {
      root.render(
        <ActivityPresenter
          control={controlA}
          enabled={true}
          onRender={() => {
            renderCount++
          }}
        />
      )
    })

    // 在途时暂停 (enabled: false)
    await act(async () => {
      root.render(
        <ActivityPresenter
          control={controlA}
          enabled={false}
          onRender={() => {
            renderCount++
          }}
        />
      )
    })

    const pauseRenderCount = renderCount

    // 此时后台异步结果晚到解决
    await act(async () => {
      resolveHistoryPage({
        agentSessionId: controlA.agentSessionId,
        source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
        items: [
          {
            id: 'late-rec-1',
            kind: 'user-message',
            contentParts: [{ kind: 'text', text: 'Late arriving query' }],
            startedAt: 10_000
          }
        ],
        nextCursor: null
      })
    })

    expect(renderCount, 'Paused component must not be re-rendered by late arrival').toBe(pauseRenderCount)
  })

  it('run/host/session 切换清旧投影与资源，新 key 迟到不串', async () => {
    const pageA: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-a' },
      items: [
        {
          id: 'session-a-turn-1',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Session A specific text' }],
          startedAt: 10_000
        }
      ],
      nextCursor: null
    }

    const pageB: AgentSessionHistoryPage = {
      agentSessionId: controlB.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-b' },
      items: [
        {
          id: 'session-b-turn-1',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Session B specific text' }],
          startedAt: 20_000
        }
      ],
      nextCursor: null
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (control) => {
      if (control.agentSessionId === controlA.agentSessionId) return pageA
      return pageB
    })

    // 1. 渲染 Session A
    await act(async () => {
      root.render(<ActivityPresenter control={controlA} enabled={true} />)
    })
    expect(host.textContent).toContain('Session A specific text')

    // 2. 切换到 Session B
    await act(async () => {
      root.render(<ActivityPresenter control={controlB} enabled={true} />)
    })

    // Session A 的旧投影必须被清除，不得泄漏到 Session B
    expect(host.textContent).not.toContain('Session A specific text')
    expect(host.textContent).toContain('Session B specific text')
  })

  it('多消费者 singleflight 共享单条网络请求，真正无消费者时才释放资源', async () => {
    let resolvePage!: (page: AgentSessionHistoryPage) => void
    const pendingPromise = new Promise<AgentSessionHistoryPage>((resolve) => {
      resolvePage = resolve
    })

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockReturnValue(pendingPromise)

    function MultiHost({ showConsumer1, showConsumer2 }: { showConsumer1: boolean; showConsumer2: boolean }) {
      return (
        <div>
          {showConsumer1 ? <ActivityPresenter control={controlA} enabled={true} /> : null}
          {showConsumer2 ? <ActivityPresenter control={controlA} enabled={true} /> : null}
        </div>
      )
    }

    // 挂载两个 consumer
    await act(async () => {
      root.render(<MultiHost showConsumer1={true} showConsumer2={true} />)
    })

    expect(historyPageSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvePage({
        agentSessionId: controlA.agentSessionId,
        source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
        items: [
          {
            id: 'multi-turn-1',
            kind: 'user-message',
            contentParts: [{ kind: 'text', text: 'Shared request content' }],
            startedAt: 10_000
          }
        ],
        nextCursor: null
      })
    })

    const bodies = host.querySelectorAll('.log-turn__body')
    expect(bodies.length).toBe(2)

    await act(async () => {
      root.render(<MultiHost showConsumer1={false} showConsumer2={true} />)
    })
    expect(host.querySelectorAll('.log-turn__body').length).toBe(1)

    await act(async () => {
      root.render(<MultiHost showConsumer1={false} showConsumer2={false} />)
    })
    expect(host.querySelectorAll('.log-turn__body').length).toBe(0)
  })

  it('隐藏时停止 timeline 观察，新相关 timeline 变化不触发隐藏重渲染与工作', async () => {
    const historyPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'turn-steady',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Steady prompt' }],
          startedAt: 10_000
        }
      ],
      nextCursor: null
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(historyPage)

    let renderCount = 0
    await act(async () => {
      root.render(
        <ActivityPresenter
          control={controlA}
          enabled={false}
          onRender={() => {
            renderCount++
          }}
        />
      )
    })

    const baselineRenderCount = renderCount

    // 在 hidden 期间更新当前 Session 的 timeline
    await act(async () => {
      useAppStore.setState({
        timelines: {
          [controlA.agentSessionId]: {
            agentSessionId: controlA.agentSessionId,
            items: [
              {
                id: 'active-turn-new',
                agentSessionId: controlA.agentSessionId,
                kind: 'user_message',
                status: 'complete',
                source: 'user',
                title: 'New prompt',
                content: 'New content while hidden',
                createdAt: 20_000,
                updatedAt: 20_000
              }
            ],
            revision: 2
          }
        }
      })
    })

    // 暂停时应停止观察，不增加工作，不触发隐藏重渲染
    expect(renderCount, 'Hidden component must not re-render on timeline changes').toBe(baselineRenderCount)
  })

  it('证伪 10 (aborted render 不污染已提交快照): startTransition 渲染 B 并在同轮悬挂/中止，返回 A (enabled:false) 时保持原三 DOM 节点及 Range', async () => {
    const identicalText = 'Identical prompt across aborted render'

    const historyPageA: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'native-a-1',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: identicalText }],
          startedAt: 10_000
        },
        {
          id: 'native-a-2',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: identicalText }],
          startedAt: 11_000
        }
      ],
      nextCursor: null
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (ctrl) => {
      if (ctrl.agentSessionId === controlA.agentSessionId) return historyPageA
      return {
        agentSessionId: controlB.agentSessionId,
        source: { providerId: 'claude', nativeSessionId: 'claude-session-2' },
        items: [],
        nextCursor: null
      }
    })

    const capturedTimelineItem: AgentTimelineItem = {
      id: 'captured-a-3',
      agentSessionId: controlA.agentSessionId,
      kind: 'user_message',
      status: 'complete',
      source: 'user',
      title: 'Prompt',
      content: identicalText,
      createdAt: 12_000,
      updatedAt: 12_000
    }

    useAppStore.setState({
      timelines: {
        [controlA.agentSessionId]: {
          agentSessionId: controlA.agentSessionId,
          items: [capturedTimelineItem],
          revision: 1
        }
      }
    })

    let suspendPromise: Promise<void> | null = null

    function SuspenseSibling({ shouldSuspend }: { shouldSuspend: boolean }) {
      if (shouldSuspend) {
        if (!suspendPromise) {
          suspendPromise = new Promise<void>(() => {})
        }
        throw suspendPromise
      }
      return <div data-testid="sibling-ready">Ready</div>
    }

    function AbortHost({
      currentControl,
      enabled,
      shouldSuspend,
      items
    }: {
      currentControl: AgentSessionControl
      enabled: boolean
      shouldSuspend: boolean
      items: AgentTimelineItem[]
    }) {
      return (
        <div>
          <Suspense fallback={<div data-testid="suspense-fallback">Suspending...</div>}>
            <SuspenseSibling shouldSuspend={shouldSuspend} />
          </Suspense>
          <ActivityPresenter control={currentControl} enabled={enabled} items={items} />
        </div>
      )
    }

    // 1. Commit A 的三个正文 (native 1, native 2, captured 3)
    await act(async () => {
      root.render(
        <AbortHost
          currentControl={controlA}
          enabled={true}
          shouldSuspend={false}
          items={[capturedTimelineItem]}
        />
      )
    })

    const turnsBefore = host.querySelectorAll('.log-turn')
    expect(turnsBefore.length).toBe(3)

    const nativeBody1 = turnsBefore[0]?.querySelector('.log-turn__body') as HTMLDivElement | null
    const nativeBody2 = turnsBefore[1]?.querySelector('.log-turn__body') as HTMLDivElement | null
    const capturedBody3 = turnsBefore[2]?.querySelector('.log-turn__body') as HTMLDivElement | null

    expect(nativeBody1).not.toBeNull()
    expect(nativeBody2).not.toBeNull()
    expect(capturedBody3).not.toBeNull()
    expect(nativeBody1!.isConnected).toBe(true)

    // 设置 DOM Range 在 nativeBody1
    const range = document.createRange()
    range.selectNodeContents(nativeBody1!)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    expect(sel.getRangeAt(0).startContainer).toBe(nativeBody1)

    // 2. startTransition 在同组件 render B，Sibling Suspense 实际 throw，B render 执行但未 commit
    await act(async () => {
      startTransition(() => {
        root.render(
          <AbortHost
            currentControl={controlB}
            enabled={true}
            shouldSuspend={true}
            items={[]}
          />
        )
      })
    })

    // 此时 transition 悬挂，未提交。原 A 的节点依然连接在 DOM 上
    expect(nativeBody1!.isConnected, 'nativeBody1 remains connected while B is suspended').toBe(true)

    // 3. 返回原 A (enabled: false)，例如此时回到 A 的覆盖视图
    await act(async () => {
      root.render(
        <AbortHost
          currentControl={controlA}
          enabled={false}
          shouldSuspend={false}
          items={[capturedTimelineItem]}
        />
      )
    })

    // 关键断言 (证伪点):
    // 若在 render 期间写 ref 改写了 lastSessionKeyRef，则 A 会被误当成新 key，正文变 []，原 DOM 全断，Range 全断
    // 修复后：原三个 DOM 节点必须保持连接，且 Range.startContainer 未断
    expect(nativeBody1!.isConnected, 'nativeBody1 must remain connected after returning to A paused').toBe(true)
    expect(nativeBody2!.isConnected, 'nativeBody2 must remain connected after returning to A paused').toBe(true)
    expect(capturedBody3!.isConnected, 'capturedBody3 must remain connected after returning to A paused').toBe(true)

    const turnsAfter = host.querySelectorAll('.log-turn')
    expect(turnsAfter.length, 'All 3 turns must remain present in DOM').toBe(3)

    const currentNative1 = turnsAfter[0]?.querySelector('.log-turn__body')
    expect(currentNative1, 'Body node instance must be preserved').toBe(nativeBody1)

    expect(sel.rangeCount).toBe(1)
    expect(sel.getRangeAt(0).startContainer, 'Range startContainer must remain nativeBody1').toBe(nativeBody1)
  })
})
