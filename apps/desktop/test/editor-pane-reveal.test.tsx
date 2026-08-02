import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { revealInFileManagerLabel } from '../src/renderer/src/lib/host-platform.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

// EditorPane opens with `import '../monaco'`, whose real module pulls Vite `?worker` graphs that a
// plain vitest run cannot resolve. Stub the side-effect import and the Monaco editor component so the
// failure-state assembly (the only path under test) renders without a browser editor context.
vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: () => null
}))

// store 替身的键集与动作 spy 都来自 test/helpers/editor-pane-store，不在这里手抄：EditorPane 新读一个
// slice 时，手抄的字面量会缺键，而缺键只在**渲染期**炸（宽类型让 tsc 全程沉默）。那份 helper 带一条
// 双向比对的检测器（editor-pane-store-fixture.test.ts），键集漏了会在那里点名。
//
// 为什么不在 vi.hoisted 里取：hoisted 回调提到所有 import 之前执行，那时 helper 还没加载，而 ESM 下
// 没有 require。vi.mock 的工厂相反是懒执行的，所以键集在那里填；hoisted 只留空壳共享引用。
const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown> & { reportError: ReturnType<typeof vi.fn> }
}))

vi.mock('../src/renderer/src/store.js', async () => {
  // 懒执行：到这里 helper 已经可以 import 了。键集与动作 spy 都由它给。
  const { editorPaneStoreState } = await import('./helpers/editor-pane-store.js')
  Object.assign(fixture.state, editorPaneStoreState())
  return {
    useAppStore: Object.assign(
      (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
      { getState: () => fixture.state }
    )
  }
})

const filesApi = vi.hoisted(() => ({
  reveal: vi.fn(async () => {})
}))

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { files: filesApi }
}))

import {
  EditorPane,
  EditorUnavailableState,
  revealFileInFileManager
} from '../src/renderer/src/components/EditorPane.js'
import { EditorReleasedState } from '../src/renderer/src/components/EditorReleasedState.js'
import { WorkspaceFiles, localExistingAncestorWithin } from '../src/main/workspace-files.js'

const localWorkspace: WorkspaceRecord = {
  id: 'workspace',
  name: 'Project',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

const remoteWorkspace: WorkspaceRecord = {
  id: 'remote',
  name: 'Server',
  hostId: 'server-ssh',
  path: '/srv/project',
  kind: 'folder'
}

function fileSurface(workspaceId: string, path: string) {
  return { regionId: 'region', kind: 'file' as const, workspaceId, path }
}

describe('EditorPane Monaco owner lifetime', () => {
  it('clears stale refs on release/document loss and fences late Monaco disposal', async () => {
    const source = await readFile(new URL('../src/renderer/src/components/EditorPane.tsx', import.meta.url), 'utf8')
    expect(source).toContain('if (released || !document)')
    expect(source).toContain('editorRef.current = null')
    expect(source).toMatch(/editor\.onDidDispose\(\(\) => \{[\s\S]*editorRef\.current === editor[\s\S]*editorRef\.current = null/)
  })

  it('恢复出来的文件面会主动要文档——恢复路径唯一的触发器就在这里', async () => {
    // 这条是源码文本断言，因为它守的东西**没有任何行为测试够得着**：本仓的 EditorPane 测试用
    // `renderToStaticMarkup`（react-dom/server），它根本不跑 useEffect；而 store 侧的测试是直接
    // 调 `attachPersistedFileDocument` action，不挂组件。也就是说把下面这个 effect 整个删掉，
    // store-persistence(16) + workbench-persistence(14) + editor-pane-reveal(15) +
    // editor-save-wiring(5) 共 50 条全绿——实测过，不是推测。
    //
    // 而这个 effect 是「重启后 tab 在、点开报不可用」这个修复的**唯一**触发器：持久化侧保住了
    // 面，store 侧能装文档，但没有它，两半永远接不上，用户看到的就是原来那个 bug。所以它必须
    // 有一个会因删除而变红的守卫，哪怕只能是文本断言。
    const source = await readFile(new URL('../src/renderer/src/components/EditorPane.tsx', import.meta.url), 'utf8')

    // 触发器本身：拿到 action，并在 effect 里对着这个面自己的 workspace/path 调用它。
    expect(source).toContain('state.attachPersistedFileDocument')
    expect(source).toMatch(
      /useEffect\(\(\) => \{[\s\S]*attachPersistedDocument\(surface\.workspaceId, surface\.path\)/
    )
    // 三个守卫条件一个都不能少，各自的理由不同：`document` 挡住已加载的；`issue` 挡住已知读不到
    // 的（否则每次依赖变化都对一个坏路径重读一遍）；`released` 挡住 cold-park 占位面。
    expect(source).toMatch(/if \(document \|\| issue \|\| released\) return\s*\n\s*void attachPersistedDocument/)
  })
})

afterEach(() => {
  filesApi.reveal.mockReset()
  filesApi.reveal.mockResolvedValue(undefined)
  fixture.state.reportError.mockReset()
  fixture.state.config.workspaces = []
  fixture.state.documents = {}
})

describe('EditorUnavailableState', () => {
  it('offers a Reveal action for the unopenable file when reveal can land', () => {
    const markup = renderToStaticMarkup(
      createElement(EditorUnavailableState, { canReveal: true, onReveal: vi.fn() })
    )
    // 判据读 lib 而不是硬写 "Reveal in Finder"：这个按钮的文案随平台走（Finder / File Explorer /
    // File Manager），硬写一个就等于断言「在本机跑」。下面那两条 not.toContain 更要读 lib——硬写的
    // 那个串在非 mac 上永远不出现，负向断言会静默变恒真。lib 自己的三个字面量由
    // host-platform.test.ts 钉住，所以这里读它不构成「期望值由被测对象算出」。
    expect(markup).toContain('File is no longer available')
    expect(markup).toContain(revealInFileManagerLabel())
    expect(markup).toContain('<button')
  })

  it('omits the action entirely — never a disabled shell — when reveal cannot work', () => {
    const markup = renderToStaticMarkup(
      createElement(EditorUnavailableState, { canReveal: false, onReveal: vi.fn() })
    )
    expect(markup).toContain('File is no longer available')
    expect(markup).not.toContain(revealInFileManagerLabel())
    expect(markup).not.toContain('<button')
  })

  it('invokes onReveal when the action fires', () => {
    const onReveal = vi.fn()
    const element = EditorUnavailableState({ canReveal: true, onReveal }) as unknown as {
      props: { children: [unknown, unknown, { props: { onClick: () => void } }] }
    }
    element.props.children[2].props.onClick()
    expect(onReveal).toHaveBeenCalledTimes(1)
  })
})

describe('revealFileInFileManager', () => {
  it('routes through the existing api.files.reveal channel — no second path resolution', async () => {
    const reportError = vi.fn()
    await revealFileInFileManager('workspace', 'src/gone.ts', reportError)
    expect(filesApi.reveal).toHaveBeenCalledWith('workspace', 'src/gone.ts')
    expect(reportError).not.toHaveBeenCalled()
  })

  it('surfaces a reveal failure through reportError instead of throwing or a second error state', async () => {
    const boom = new Error('reveal blew up')
    filesApi.reveal.mockRejectedValueOnce(boom)
    const reportError = vi.fn()
    await expect(revealFileInFileManager('workspace', 'src/gone.ts', reportError)).resolves.toBeUndefined()
    expect(reportError).toHaveBeenCalledWith(boom)
  })
})

describe('EditorPane failure state wiring', () => {
  it('renders the Monaco release state while retaining the Region document projection', () => {
    const markup = renderToStaticMarkup(
      createElement(EditorPane, {
        tabId: 'tab',
        surface: fileSurface('workspace', 'src/parked.ts'),
        released: true
      })
    )
    expect(markup).toContain('Editor parked')
    expect(markup).toContain('restore the editor')
    expect(markup).not.toContain('Loading editor')
  })

  it('exposes a standalone release state for mutation-proof rendering tests', () => {
    expect(renderToStaticMarkup(createElement(EditorReleasedState))).toContain('Editor parked')
  })

  it('shows the Reveal action for a missing document in a local workspace', () => {
    fixture.state.config.workspaces = [localWorkspace]
    const markup = renderToStaticMarkup(
      createElement(EditorPane, { tabId: 'tab', surface: fileSurface('workspace', 'src/gone.ts') })
    )
    expect(markup).toContain('File is no longer available')
    expect(markup).toContain(revealInFileManagerLabel())
  })

  it('withholds the Reveal action for a remote (non-local) workspace', () => {
    fixture.state.config.workspaces = [remoteWorkspace]
    const markup = renderToStaticMarkup(
      createElement(EditorPane, { tabId: 'tab', surface: fileSurface('remote', 'src/gone.ts') })
    )
    expect(markup).toContain('File is no longer available')
    expect(markup).not.toContain(revealInFileManagerLabel())
  })
})

// The reveal channel this action shares (localPathForReveal) must survive a deleted target: a file
// being gone is the most common reason it "won't open", and the fallback below is exactly what keeps
// the action from turning into a second error. These exercise the real inline worker on a temp tree.
describe('WorkspaceFiles reveal fallback for the failure state', () => {
  const revealRoots: string[] = []

  function localHost(): ExecutionHost {
    return {
      id: 'local',
      kind: 'local',
      label: 'Local',
      run: vi.fn(),
      exposeLoopbackPort: async (port) => port,
      dispose: async () => {}
    }
  }

  async function revealWorkspace(label: string): Promise<{ root: string; workspace: WorkspaceRecord }> {
    const fixtureDir = await mkdtemp(join(tmpdir(), `agentmux-${label}-`))
    revealRoots.push(fixtureDir)
    const root = join(fixtureDir, 'workspace')
    await mkdir(root)
    return {
      root,
      workspace: { id: label, name: label, hostId: 'local', path: root, kind: 'folder' }
    }
  }

  afterEach(async () => {
    await Promise.all(revealRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('reveals a deleted file by falling back to its nearest existing ancestor directory', async () => {
    const { root, workspace } = await revealWorkspace('reveal-deleted')
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    const files = new WorkspaceFiles(() => localHost())

    // The file and its immediate parent never existed; reveal must climb to the folder that does.
    const revealed = await files.localPathForReveal(workspace, 'src/nested/gone/missing.ts')
    expect(revealed).toBe(await realpath(join(root, 'src', 'nested')))
  })

  it('falls all the way back to the workspace root when the whole subtree is gone', async () => {
    const { root, workspace } = await revealWorkspace('reveal-root')
    const files = new WorkspaceFiles(() => localHost())

    const revealed = await files.localPathForReveal(workspace, 'never/here/at/all.ts')
    expect(revealed).toBe(await realpath(root))
  })

  it('still reveals an existing file directly, unchanged by the fallback', async () => {
    const { root, workspace } = await revealWorkspace('reveal-existing')
    await writeFile(join(root, 'present.ts'), 'x')
    const files = new WorkspaceFiles(() => localHost())

    const revealed = await files.localPathForReveal(workspace, 'present.ts')
    expect(revealed).toBe(await realpath(join(root, 'present.ts')))
  })

  it('rejects when the ancestor climb resolves through a symlink that escapes the root', async () => {
    const { root } = await revealWorkspace('reveal-symlink-escape')
    // A directory inside the workspace symlinked to a real location OUTSIDE the root. The reveal
    // target below never exists, so the climb lands on this symlink — whose realpath is outside the
    // workspace. Confinement (assertRealPathWithin) must reject it, not surface a folder outside root.
    //
    // Asserted directly against localExistingAncestorWithin, the helper the confinement line lives in,
    // NOT through localPathForReveal: the local worker spawns with cwd = the resolved dir and applies
    // its OWN 'Path escapes the workspace root' guard, which would mask a removed confinement here and
    // let the mutation survive. This layered assertion is what actually goes red when line 298 is cut.
    const outside = join(root, '..', 'outside-secret')
    await mkdir(outside)
    await symlink(await realpath(outside), join(root, 'escape'), 'dir')

    await expect(localExistingAncestorWithin(root, 'escape/gone.ts')).rejects.toThrow(
      'Path escapes the workspace root'
    )
  })

  it('refuses to reveal on a non-local workspace rather than offer a doomed action', async () => {
    const remote: WorkspaceRecord = {
      id: 'remote',
      name: 'remote',
      hostId: 'remote-ssh',
      path: '/srv/project',
      kind: 'folder'
    }
    const remoteHost: ExecutionHost = { ...localHost(), id: 'remote-ssh', kind: 'ssh' }
    const files = new WorkspaceFiles(() => remoteHost)

    await expect(files.localPathForReveal(remote, 'anything.ts')).rejects.toThrow(
      'Reveal in file manager is available only for local paths'
    )
  })
})
