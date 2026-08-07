import { describe, expect, it, vi } from 'vitest'
import {
  isAllowedTopFrameNavigation,
  topFrameNavigationGuard,
  topFrameOrigin,
  type TopFrameOrigin
} from '../src/main/top-frame-navigation.js'
import { installFileDropGuard } from '../src/renderer/src/lib/file-drop-guard.js'

/**
 * 顶帧导航闸的判据测试。这道闸买的是「主窗口顶帧永远是应用自己的文档」，从而 preload 挂的特权桥
 * （src/preload/index.ts:238）永远只落在受应用 <meta> CSP 约束的应用文档上；拖入的恶意文件无法成为
 * 顶帧文档去继承那座桥。判据是纯函数，这里直接质询它；接线（挂 will-navigate + 被拒时 preventDefault）
 * 由 main-window-setup.test.ts 的接线守卫钉住。
 */

const DEV: TopFrameOrigin = { mode: 'dev', origin: 'http://localhost:5173' }
const PROD: TopFrameOrigin = { mode: 'prod', filePath: '/Applications/AgentMux.app/renderer/index.html' }

describe('topFrameOrigin: derive the app origin from the same source the window loads', () => {
  it('dev shape: takes the dev-server origin when ELECTRON_RENDERER_URL is set', () => {
    // origin 只保留 scheme+host+port，路径被丢掉——dev 下同源判据就是这个 origin。
    expect(topFrameOrigin({
      rendererDevServerUrl: 'http://localhost:5173/index.html',
      packagedRendererFilePath: '/pkg/renderer/index.html'
    })).toEqual({ mode: 'dev', origin: 'http://localhost:5173' })
  })

  it('prod shape: falls back to the packaged renderer file path when no dev URL', () => {
    // dev URL 缺席（打包运行）时走 prod 分支，判据锚点是被打包文档的绝对路径。
    expect(topFrameOrigin({
      rendererDevServerUrl: undefined,
      packagedRendererFilePath: '/pkg/renderer/index.html'
    })).toEqual({ mode: 'prod', filePath: '/pkg/renderer/index.html' })
  })

  it('prod shape: an empty dev URL string is treated as absent (not a broken dev origin)', () => {
    // 空串不是一个合法 dev origin。若当成 dev 处理，new URL('') 会抛；这里必须退回 prod。
    expect(topFrameOrigin({
      rendererDevServerUrl: '',
      packagedRendererFilePath: '/pkg/renderer/index.html'
    })).toEqual({ mode: 'prod', filePath: '/pkg/renderer/index.html' })
  })
})

describe('isAllowedTopFrameNavigation: dev shape (Vite dev server origin)', () => {
  it('allows same-origin navigation within the dev server (HMR / in-app routing)', () => {
    expect(isAllowedTopFrameNavigation(DEV, 'http://localhost:5173/')).toBe(true)
    expect(isAllowedTopFrameNavigation(DEV, 'http://localhost:5173/index.html')).toBe(true)
    expect(isAllowedTopFrameNavigation(DEV, 'http://localhost:5173/some/route?x=1#h')).toBe(true)
  })

  it('rejects a cross-origin https:// target', () => {
    // 最直接的威胁形状：被诱导导航到外部站点。
    expect(isAllowedTopFrameNavigation(DEV, 'https://evil.example/x')).toBe(false)
  })

  it('rejects a different port / host on the same scheme', () => {
    expect(isAllowedTopFrameNavigation(DEV, 'http://localhost:5174/')).toBe(false)
    expect(isAllowedTopFrameNavigation(DEV, 'http://127.0.0.1:5173/')).toBe(false)
  })

  it('rejects a file:// target even in dev (a dropped file must never be same-origin)', () => {
    // file:// 的 origin 是 "null"，与 dev 的 http origin 不等——这正是拖入文件在 dev 下也被拒的原因。
    expect(isAllowedTopFrameNavigation(DEV, 'file:///tmp/evil.html')).toBe(false)
  })

  it('allows a URL with embedded credentials to the same origin (credentials do not change origin)', () => {
    // http://user:pass@localhost:5173 的 origin 剥掉凭据后与裸 origin 相等——凭据不改变来源，放行符合预期。
    expect(isAllowedTopFrameNavigation(DEV, 'http://user:pass@localhost:5173/')).toBe(true)
  })

  it('treats host case-insensitively (URL parsing lower-cases the host)', () => {
    expect(isAllowedTopFrameNavigation(DEV, 'http://LOCALHOST:5173/')).toBe(true)
  })
})

describe('isAllowedTopFrameNavigation: prod shape (packaged file:// document)', () => {
  it('allows navigation to the exact packaged renderer document', () => {
    expect(isAllowedTopFrameNavigation(PROD, 'file:///Applications/AgentMux.app/renderer/index.html')).toBe(true)
  })

  it('allows the packaged document with a probe query / hash (query and hash are ignored)', () => {
    // 资源/文件编辑探针会带 ?agentmux-file-editing-report=1 之类；判据落在路径上，忽略 query/hash。
    expect(isAllowedTopFrameNavigation(
      PROD,
      'file:///Applications/AgentMux.app/renderer/index.html?agentmux-file-editing-report=1'
    )).toBe(true)
    expect(isAllowedTopFrameNavigation(
      PROD,
      'file:///Applications/AgentMux.app/renderer/index.html#section'
    )).toBe(true)
  })

  it('REJECTS a different file:// path — the dropped-file hole (origin is "null" for all file URLs)', () => {
    // 这条是本模块存在的理由：若 prod 按 origin 相等判，file:///tmp/evil.html 的 origin 同样是 "null"，
    // 会被判成同源而放行。判据必须比路径，才能拒掉拖入的任意文件。
    expect(isAllowedTopFrameNavigation(PROD, 'file:///tmp/evil.html')).toBe(false)
    expect(isAllowedTopFrameNavigation(PROD, 'file:///Applications/AgentMux.app/renderer/evil.html')).toBe(false)
    expect(isAllowedTopFrameNavigation(PROD, 'file:///Applications/AgentMux.app/../evil.html')).toBe(false)
  })

  it('rejects an http(s):// target in prod (only the packaged file is home)', () => {
    expect(isAllowedTopFrameNavigation(PROD, 'https://evil.example/x')).toBe(false)
    expect(isAllowedTopFrameNavigation(PROD, 'http://localhost:5173/')).toBe(false)
  })

  it('matches a percent-encoded path back to the packaged document (spaces in the app path)', () => {
    const spaced: TopFrameOrigin = { mode: 'prod', filePath: '/Applications/Agent Mux.app/renderer/index.html' }
    expect(isAllowedTopFrameNavigation(spaced, 'file:///Applications/Agent%20Mux.app/renderer/index.html')).toBe(true)
  })

  it('rejects a malformed percent sequence rather than throwing or allowing', () => {
    expect(isAllowedTopFrameNavigation(PROD, 'file:///Applications/AgentMux.app/renderer/%E0%A4%A.html')).toBe(false)
  })
})

describe('isAllowedTopFrameNavigation: shared hazards (both shapes)', () => {
  it('rejects about:blank', () => {
    // about:blank 本身不载入危险内容，但顶帧没有理由离开应用文档去那里；一律拒，最小化面。
    expect(isAllowedTopFrameNavigation(DEV, 'about:blank')).toBe(false)
    expect(isAllowedTopFrameNavigation(PROD, 'about:blank')).toBe(false)
  })

  it('rejects a javascript: URL', () => {
    // javascript: 顶帧导航是脚本注入面；origin 为 "null"，两种形状都拒。
    expect(isAllowedTopFrameNavigation(DEV, 'javascript:alert(1)')).toBe(false)
    expect(isAllowedTopFrameNavigation(PROD, 'javascript:alert(document.cookie)')).toBe(false)
  })

  it('rejects a data: URL', () => {
    expect(isAllowedTopFrameNavigation(DEV, 'data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isAllowedTopFrameNavigation(PROD, 'data:text/html,x')).toBe(false)
  })

  it('rejects an unparseable target string', () => {
    // 连 URL 都解析不出来——绝不放行。
    expect(isAllowedTopFrameNavigation(DEV, 'not a url')).toBe(false)
    expect(isAllowedTopFrameNavigation(PROD, '')).toBe(false)
  })
})

/**
 * 拖放拦截：可观测地验证它真的在宿主上装了 dragover/drop 监听，且监听体真的 preventDefault——不是扫源码
 * 文本。用最小 window 替身记录注册，再模拟派发一次事件，断言 preventDefault 被调用。
 */
describe('installFileDropGuard: observable listener contract', () => {
  function host() {
    const listeners = new Map<string, EventListener>()
    return {
      listeners,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener)
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type)
      }),
      fire(type: string): { preventDefault: ReturnType<typeof vi.fn> } {
        const preventDefault = vi.fn()
        const listener = listeners.get(type)
        if (!listener) throw new Error(`no ${type} listener installed`)
        listener({ type, preventDefault } as unknown as Event)
        return { preventDefault }
      }
    }
  }

  it('installs both dragover and drop listeners', () => {
    const window = host()
    installFileDropGuard(window)
    expect(window.listeners.has('dragover')).toBe(true)
    expect(window.listeners.has('drop')).toBe(true)
  })

  it('prevents the default navigation on a dropped file (drop)', () => {
    const window = host()
    installFileDropGuard(window)
    const { preventDefault } = window.fire('drop')
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('prevents the default on dragover so the drop actually reaches us', () => {
    const window = host()
    installFileDropGuard(window)
    const { preventDefault } = window.fire('dragover')
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('returns a disposer that removes both listeners', () => {
    const window = host()
    const dispose = installFileDropGuard(window)
    dispose()
    expect(window.listeners.has('dragover')).toBe(false)
    expect(window.listeners.has('drop')).toBe(false)
  })
})

/**
 * will-navigate / will-redirect 处理器的行为测试。质询的是「被拒的那条路真的 preventDefault 了导航」，
 * 而不是「源码里出现了 will-navigate 这个字符串」。index.ts 用的就是这个工厂（topFrameNavigationGuard），
 * 所以这里执行到的分支与生产里跑的是同一份。
 */
describe('topFrameNavigationGuard: the rejection path prevents the navigation', () => {
  function event(input: { url: string; isMainFrame?: boolean }): {
    url: string
    isMainFrame: boolean
    preventDefault: ReturnType<typeof vi.fn>
  } {
    return { url: input.url, isMainFrame: input.isMainFrame ?? true, preventDefault: vi.fn() }
  }

  it('prevents a rejected cross-origin main-frame navigation (dev)', () => {
    const guard = topFrameNavigationGuard(DEV)
    const e = event({ url: 'https://evil.example/x' })
    guard(e)
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })

  it('prevents a rejected file:// drop navigation (prod)', () => {
    const guard = topFrameNavigationGuard(PROD)
    const e = event({ url: 'file:///tmp/evil.html' })
    guard(e)
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })

  it('does NOT prevent an allowed same-origin navigation (dev HMR must survive)', () => {
    const guard = topFrameNavigationGuard(DEV)
    const e = event({ url: 'http://localhost:5173/route' })
    guard(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('does NOT prevent an allowed navigation to the packaged document (prod)', () => {
    const guard = topFrameNavigationGuard(PROD)
    const e = event({ url: 'file:///Applications/AgentMux.app/renderer/index.html' })
    guard(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('leaves sub-frame navigations alone (only the top frame carries the privileged bridge)', () => {
    const guard = topFrameNavigationGuard(PROD)
    // 即便是个会被顶帧拒的 URL，只要它发生在子帧就不拦——子帧不继承顶帧那座桥。
    const e = event({ url: 'https://evil.example/x', isMainFrame: false })
    guard(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
