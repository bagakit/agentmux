import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { WorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  regionDisplayName,
  regionDisplayNames,
  regionSurfaceLabel
} from '../src/renderer/src/lib/region-display-name.js'

// ---------------------------------------------------------------------------
// 一个 Region 没有名字字段，它唯一能给人看的名全靠这里现算。这份派生此前劈成两半散在两个文件里
// （表面→短名在 WorkspaceWorkbench，重名编号在 regionSwapMenuEntries），第二个消费者（水印）即将
// 出现。这里守的正是最容易随第二份拷贝漂移的三件事：编号只出现在重名上、编号跟视觉顺序走、唯一名
// 保持裸名。以及那条被有意排除的错误签名——一个只看单格、看不见兄弟的取名函数不可能正确。
// ---------------------------------------------------------------------------

function agentSurface(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId }
}
function terminalSurface(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId }
}
function fileSurface(regionId: string, path: string): WorkbenchSurface {
  return { regionId, kind: 'file', workspaceId: 'workspace', path }
}
function launcherSurface(regionId: string): WorkbenchSurface {
  return { regionId, kind: 'launcher', workspaceId: 'workspace' }
}
function browserSurface(regionId: string, url: string, title: string): WorkbenchSurface {
  return {
    regionId,
    kind: 'browser',
    workspaceId: 'workspace',
    browserId: `browser-${regionId}`,
    id: `browser-${regionId}`,
    navigationId: 'nav-1',
    profileId: 'profile-1',
    url,
    title,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    viewport: 'desktop',
    error: null
  }
}

function agentSession(id: string, label: string): SessionSnapshot {
  return { id, kind: 'agent', label } as unknown as SessionSnapshot
}

describe('regionSurfaceLabel：一格的表面短名', () => {
  it('按表面种类取一个人能认出的名', () => {
    const sessions = [agentSession('s-a', 'Agent · repo')]
    expect(regionSurfaceLabel(fileSurface('r', 'a/b/index.ts'), sessions)).toBe('index.ts')
    expect(regionSurfaceLabel(launcherSurface('r'), sessions)).toBe('New Tab')
    expect(regionSurfaceLabel(terminalSurface('r', 's-t'), sessions)).toBe('Terminal')
    expect(regionSurfaceLabel(agentSurface('r', 's-a'), sessions)).toBe('Agent · repo')
    expect(regionSurfaceLabel(browserSurface('r', 'https://example.com', 'Example'), sessions)).toBe(
      'Example'
    )
  })

  it('浏览器无标题时退回 URL，about:blank 视为 New Tab', () => {
    expect(regionSurfaceLabel(browserSurface('r', 'https://x.dev', ''), [])).toBe('https://x.dev')
    expect(regionSurfaceLabel(browserSurface('r', 'about:blank', 'about:blank'), [])).toBe('New Tab')
  })

  it('取不到 session 时退回 sessionId，而不是抛错', () => {
    expect(regionSurfaceLabel(agentSurface('r', 'missing'), [])).toBe('missing')
  })
})

describe('regionDisplayNames：重名才编号，按视觉顺序', () => {
  it('唯一的标签保持裸名', () => {
    expect(
      regionDisplayNames([
        { regionId: 'r0', label: 'Agent · repo' },
        { regionId: 'r1', label: 'Terminal' },
        { regionId: 'r2', label: 'example.com' }
      ])
    ).toEqual([
      { regionId: 'r0', name: 'Agent · repo' },
      // 一个终端就是裸 "Terminal"，不无谓地加「1」——这是最容易被 always-number 变异改坏的判据。
      { regionId: 'r1', name: 'Terminal' },
      { regionId: 'r2', name: 'example.com' }
    ])
  })

  it('重名的按出现次序编号；编号覆盖全体含每一格自己', () => {
    expect(
      regionDisplayNames([
        { regionId: 't1', label: 'Terminal' },
        { regionId: 't2', label: 'Terminal' },
        { regionId: 't3', label: 'Terminal' },
        { regionId: 'f1', label: 'index.ts' }
      ])
    ).toEqual([
      { regionId: 't1', name: 'Terminal 1' },
      { regionId: 't2', name: 'Terminal 2' },
      { regionId: 't3', name: 'Terminal 3' },
      // index.ts 只有一个，保持裸名。
      { regionId: 'f1', name: 'index.ts' }
    ])
  })

  it('编号跟入参顺序走（视觉顺序），换序即换号', () => {
    // 同一组格子，反序喂进去，编号也随之翻转——证明编号绑定的是位置而不是 regionId。
    const forward = regionDisplayNames([
      { regionId: 'a', label: 'Terminal' },
      { regionId: 'b', label: 'Terminal' }
    ])
    const reversed = regionDisplayNames([
      { regionId: 'b', label: 'Terminal' },
      { regionId: 'a', label: 'Terminal' }
    ])
    expect(forward).toEqual([
      { regionId: 'a', name: 'Terminal 1' },
      { regionId: 'b', name: 'Terminal 2' }
    ])
    expect(reversed).toEqual([
      { regionId: 'b', name: 'Terminal 1' },
      { regionId: 'a', name: 'Terminal 2' }
    ])
  })
})

describe('regionDisplayName：单格取名，但要求整套兄弟', () => {
  it('一格的名字取决于兄弟——同名兄弟在场时它才带编号', () => {
    const withSibling = [
      { regionId: 't1', label: 'Terminal' },
      { regionId: 't2', label: 'Terminal' }
    ]
    // 同一格 t2：有同名兄弟时是 "Terminal 2"，独一份时是裸 "Terminal"。看不见兄弟就取不对。
    expect(regionDisplayName(withSibling, 't2')).toBe('Terminal 2')
    expect(regionDisplayName([{ regionId: 't2', label: 'Terminal' }], 't2')).toBe('Terminal')
  })

  it('取不到该格返回 undefined', () => {
    expect(regionDisplayName([{ regionId: 't1', label: 'Terminal' }], 'nope')).toBeUndefined()
  })
})
