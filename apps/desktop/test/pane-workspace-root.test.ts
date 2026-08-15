import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { workspaceForSession, workspaceRootForPath } from '../src/renderer/src/lib/workbench-tabs.js'
import { stepSummary } from '../src/renderer/src/lib/activity-step-summary.js'
import { resolveWorkspaceRelativePath } from '../src/renderer/src/lib/terminal-path-link.js'

// 一格终端／时间线把绝对路径缩短时，用的是**哪个**仓根。
//
// 这个判据存在，是因为「取当前激活的 workspace」在一种真实操作后会给出**错的答案而不是没有答案**：
// Move to Workspace 只搬显示身份，Session 自己的 workspacePath 从不被改写（见 move-session-view.ts）。
// 于是被搬过去的那一格，session 仍跑在原来的仓里，而 activeWorkspaceId 已经是目标仓。
//
// 若那个错的根恰好是 session 路径的**祖先**，shortenPath 的边界守卫会匹配成功并把它剥掉，
// 渲染出一条「根在另一个仓」的相对路径——它看起来完全像一个真答案。长路径只是难读，错路径是谎。

function agentAt(workspacePath: string): SessionSnapshot {
  return {
    id: 's1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'respond', providerResume: true, replyCorrelation: 'native-turn-id' },
    hostId: 'local',
    workspacePath,
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 's1', run: { runId: 'run-s1' } }
  } as unknown as SessionSnapshot
}

// 两个仓，一个是另一个的祖先——这正是守卫拦不住的那个形状（兄弟目录 /parent/other 它拦得住）。
const config = {
  workspaces: [
    { id: 'ws-parent', name: 'parent', hostId: 'local', path: '/Users/me/proj', kind: 'folder', branch: 'main' },
    { id: 'ws-repo', name: 'repo', hostId: 'local', path: '/Users/me/proj/repo', kind: 'folder', branch: 'main' }
  ]
} as unknown as AppConfig

const readOf = (path: string): string => JSON.stringify({ file_path: path })
const SESSION_FILE = '/Users/me/proj/repo/src/auth.ts'

describe('一格的仓根取自它自己的 session，不取当前激活的 workspace', () => {
  it('被搬走之后仍然缩短到自己的仓，而不是按目标仓剥前缀', () => {
    const session = agentAt('/Users/me/proj/repo')
    // 视图已被搬到 ws-parent（激活的是它），但 session 没动。
    const root = workspaceRootForPath(config, session) ?? ''
    expect(root, '仓根应当由 session 的 workspacePath 决定，与哪个 workspace 被激活无关').toBe('/Users/me/proj/repo')
    expect(stepSummary('Read', readOf(SESSION_FILE), 48, root)).toBe('src/auth.ts')
  })

  it('错的仓根是祖先时会剥出一条根在别的仓的路径——这条钉住那个坏输出不再出现', () => {
    // 这是修复前的行为：activeWorkspaceId 指向 ws-parent，于是用 /Users/me/proj 去剥。
    const wrongRoot = '/Users/me/proj'
    expect(
      stepSummary('Read', readOf(SESSION_FILE), 48, wrongRoot),
      '祖先根会匹配成功并剥掉，产出的相对路径读起来像是 parent 仓里的文件'
    ).toBe('repo/src/auth.ts')
    // 而正确的根给出的是另一个答案。两者都「看起来是对的」，所以只能靠取根这一步分辨。
    expect(stepSummary('Read', readOf(SESSION_FILE), 48, '/Users/me/proj/repo')).toBe('src/auth.ts')
  })

  it('兄弟目录不是这个问题——边界守卫本来就拦得住，别把两件事混成一条', () => {
    // /Users/me/proj/other 不是 session 路径的前缀，shortenPath 原样退回并走 ~ 折叠。
    expect(stepSummary('Read', readOf(SESSION_FILE), 48, '/Users/me/proj/other')).toBe('~/proj/repo/src/auth.ts')
  })

  it('认不出归属的 session 退回空根——宁可不缩短，也不拿一个凑合的根去剥', () => {
    const foreign = agentAt('/Users/me/elsewhere/thing')
    expect(workspaceRootForPath(config, foreign)).toBeUndefined()
    // 空根＝不剥仓根，只做 ~ 折叠。长，但不假。
    expect(stepSummary('Read', readOf(SESSION_FILE), 48, '')).toBe('~/proj/repo/src/auth.ts')
  })
})

// 「归属」与「包含」是两个问题，分成两个函数而不是把归属放宽——放宽会改动八个只要精确归属的调用方
// （侧栏计数、Topic 绑定、工具坞、持久化…），拿正确性换排版。
//
// 触发这条判据的是一个真实操作：文件树右键「Open in Terminal」一个**子目录**，
// store 落下 `workspacePath: /repo/sub`（store.ts `workspacePath ?? workspace.path`），
// 而没有任何 workspace **精确**拥有它。
describe('子目录终端：路径的根问「落在哪个仓里」，不问「归谁所有」', () => {
  const subdir = agentAt('/Users/me/proj/repo/apps/desktop')

  it('归属答不出——这正是它必须是另一个问题的原因', () => {
    expect(workspaceForSession(config, subdir)).toBeUndefined()
  })

  it('包含答得出，并且取最长的那个仓（嵌套时不能剥到外层去）', () => {
    // /Users/me/proj 与 /Users/me/proj/repo 都注册着，两个都「包含」它。取长的那个：
    // 取短的会剥出 `repo/apps/...`，读起来像是 parent 仓里的文件——正是上面钉住的那种坏输出。
    expect(workspaceRootForPath(config, subdir)).toBe('/Users/me/proj/repo')
  })

  it('取不到根时，这一格的绝对路径链接会整个失效——不是变长，是点不开', () => {
    // resolveWorkspaceRelativePath 对任何绝对路径在空根下一律返回 null，
    // 而 null 意味着这段文本不被下划线、点了也没有反应。
    // 「长」只是难读，「死」是把用户本来有的能力拿走了（原则 11：绕过我这段代码这条路还通吗？通 ⇒ 红线）。
    expect(resolveWorkspaceRelativePath(SESSION_FILE, '')).toBeNull()
    expect(resolveWorkspaceRelativePath(SESSION_FILE, workspaceRootForPath(config, subdir) ?? ''))
      .toBe('src/auth.ts')
  })

  it('不是同一台机器上的仓不算包含——前缀像也不行', () => {
    const remote = { ...agentAt('/Users/me/proj/repo/apps'), hostId: 'other' } as SessionSnapshot
    expect(workspaceRootForPath(config, remote)).toBeUndefined()
  })

  it('只在路径分隔处切，`/proj/repo-backup` 不算 `/proj/repo` 的子目录', () => {
    // 裸 startsWith 会把它算进去，于是剥出 `-backup/x.ts` 这种没有任何意义的相对路径。
    const sibling = agentAt('/Users/me/proj/repo-backup/src')
    expect(workspaceRootForPath(config, sibling)).toBe('/Users/me/proj')
  })
})
