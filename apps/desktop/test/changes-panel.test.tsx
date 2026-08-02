import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

// api 在模块加载时就要判断跑在哪个宿主里；不先立起这个全局，import 阶段就炸。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { GitFileChange, GitStatusResult, WorkspaceRecord } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  git: { status: null as GitStatusResult | null, loading: false, error: null as string | null },
  state: { openFileDiff: vi.fn() }
}))

// useGitStatus 靠 useEffect 取数，而 renderToStaticMarkup **不跑 effect**——真用它就永远只能渲染出
// 「还在加载」。所以这里换掉 hook 本身，让 status 成为测试能控制的输入。
vi.mock('../src/renderer/src/hooks/useGitStatus.js', () => ({
  useGitStatus: () => ({ ...fixture.git, refresh: vi.fn() })
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel.js'
import {
  GIT_REMOTE_SUCCESS,
  type GitRemoteVerb
} from '../src/renderer/src/lib/git-remote-outcome.js'

const CHANGES_PANEL_TSX = new URL(
  '../src/renderer/src/components/ChangesPanel.tsx',
  import.meta.url
)
const PANEL_SOURCE = readFileSync(CHANGES_PANEL_TSX, 'utf8')
const PANEL_AST = ts.createSourceFile(
  'ChangesPanel.tsx',
  PANEL_SOURCE,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

/** 某个被调函数的每个调用点的实参文本。判接线时的共用取值器。 */
function callSites(callee: string): string[][] {
  const out: string[][] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(PANEL_AST) === callee) {
      out.push(node.arguments.map((argument) => argument.getText(PANEL_AST)))
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(PANEL_AST, walk)
  return out
}

/** 某个函数声明的整段源码（含体）。按名字取，不靠行号。 */
function functionBody(name: string): string | null {
  let found: string | null = null
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.getText(PANEL_AST) === name) {
      found = node.getText(PANEL_AST)
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(PANEL_AST, walk)
  return found
}

/**
 * 某个 state 变量的每一处**读取**，各自被喂给了谁。
 *
 * 判据写成正向（「每个取值位都进了 X」）而不是反向（「`state ===` 这个形状不在场」）：记忆
 * forbidden-shape-guard-misfires——禁止形状的判据既漏（换个拼法就绕过：`!==`、`!= null`、
 * 反着写 `path === state`、`[state].includes(path)`）又误伤（本文件注释里写下那个反例就当场
 * 打红，实测中过一次）。正向判据把这两侧一起解决：拼法再多也都是「读了它」，而注释根本不是
 * 标识符，AST 里不存在。
 *
 * 排除声明处（`const [x, setX] = useState(...)` 里的绑定名）与 setter 名本身——那两个不是读取。
 * 返回每个读取位的**父节点文本**，调用方据此质询「它进的是不是那个唯一的判定」。
 */
function readsOf(state: string, source: string, fileName = 'probe.tsx'): string[] {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === state && !ts.isBindingElement(node.parent)) {
      out.push(node.parent.getText(ast))
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return out
}

const workspace: WorkspaceRecord = {
  id: 'ws-1',
  name: 'repo',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

/** 一条 git 变更。index/worktree 是 git 的两列状态码，两者含义不同——这正是被守的判据之一。 */
function change(path: string, overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path,
    origPath: null,
    index: ' ',
    worktree: ' ',
    staged: false,
    unstaged: false,
    untracked: false,
    ...overrides
  }
}

function render(changes: GitFileChange[]): string {
  fixture.git.status = {
    kind: 'git-repository',
    hostId: 'local',
    repoPath: '/repo',
    branch: 'main',
    changes
  }
  return renderToStaticMarkup(createElement(ChangesPanel, { workspace }))
}

/**
 * 取出一个分组的那一段标记。两个分组用同一套 `change-row` 类名，所以「文件出现在页面上」证不了
 * 「它出现在**对的**分组里」——必须按分组切片，否则对调谓词后断言照旧通过。
 */
function group(markup: string, label: 'Staged' | 'Changes'): string {
  const head = `<div class="branch-group"><span>${label}</span>`
  const start = markup.indexOf(head)
  expect(start, `没渲染出 ${label} 分组——判据落空了，下面的断言会变成恒真`).toBeGreaterThanOrEqual(0)
  const rest = markup.slice(start + head.length)
  const next = rest.indexOf('<div class="branch-group">')
  return next < 0 ? rest : rest.slice(0, next)
}

afterEach(() => {
  fixture.git = { status: null, loading: false, error: null }
  fixture.state.openFileDiff.mockReset()
})

/**
 * 提交区两个控件各自的 disabled。**必须分开读**：两者的表达式不同（按钮多一个「消息非空」的合取项），
 * 一个 `markup.toContain('disabled=""')` 分不清是谁关着，也就分不清删掉了哪一个合取项。
 */
function disabled(markup: string, which: 'textarea' | 'submit'): boolean {
  const head = which === 'textarea' ? '<textarea ' : '<button type="submit" '
  const start = markup.indexOf(head)
  expect(start, `提交区没渲染出 ${which}——判据落空了`).toBeGreaterThanOrEqual(0)
  const openTag = markup.slice(start, markup.indexOf('>', start))
  return openTag.includes('disabled=""')
}

/**
 * Source Control 的渲染守卫。
 *
 * 此前 `ChangesPanel` 在整个 test/ 目录里**零引用**——没有任何测试渲染过它，对它的引用只有别的测试
 * 文件里的 `readFileSync().toContain()` 源码文本断言。于是这一族全部无人守：
 *
 * - 把 `staged`/`unstaged` 两个谓词对调（:53 / :57），文件进错分组；
 * - 把传给 `changeRow` 的 `canStage` 对调（:143 / :146），**未暂存文件不再渲染暂存按钮**——用户没有
 *   任何入口把文件加进暂存区，提交流程死锁；
 * - `changeLabel` 读错状态列（:23，`staged ? index : worktree` 取反），每一行都退化成泛化的
 *   "Changed"，看不出到底是改了、加了还是删了。
 *
 * `git-status-porcelain.test.ts` 挡不住任何一条：它断言的是**数据模型**（porcelain 两列解析成
 * staged/unstaged/untracked 布尔），到 `change.staged` 为止就停了；面板怎么用这个布尔分组、怎么选
 * 状态列、画 `+` 还是 `✓`，它一概不碰。`tsc` 也挡不住——对调的两侧类型完全相同。
 */
describe('Source Control 面板', () => {
  it('暂存与未暂存分到各自的组里，且只有未暂存的那条给得出暂存入口', () => {
    const markup = render([
      change('src/staged.ts', { index: 'M', staged: true }),
      change('src/dirty.ts', { worktree: 'M', unstaged: true })
    ])

    const stagedGroup = group(markup, 'Staged')
    const changesGroup = group(markup, 'Changes')

    // 分组归属：各自只在自己那一组里。谓词对调时两条都红。
    expect(stagedGroup).toContain('staged.ts')
    expect(stagedGroup).not.toContain('dirty.ts')
    expect(changesGroup).toContain('dirty.ts')
    expect(changesGroup).not.toContain('staged.ts')

    // canStage：只有未暂存那条有暂存按钮，已暂存那条给的是**退回**入口。这两条守的是「入口在不在」，
    // 与分组归属正交——把 changeRow 的两个布尔对调时，上面四条仍绿，只有这两条红。
    expect(changesGroup, '未暂存的文件没有暂存按钮——用户无法把它加进暂存区')
      .toContain('aria-label="Stage src/dirty.ts"')
    expect(stagedGroup, '已暂存的文件又给了一次暂存按钮').not.toContain('aria-label="Stage')
    expect(stagedGroup, '已暂存的文件没有退回入口——暂存了就下不来（#206）')
      .toContain('aria-label="Unstage src/staged.ts"')
    // 反向：Unstage 只在已暂存那一族。给未暂存的文件也画一个「退回」按钮是在说一件做不到的事
    // （main 侧 `restore --staged` 对没进 index 的文件是 no-op），而它长得和真入口一样。
    expect(changesGroup, '未暂存的文件也给了退回入口——那个按钮点了什么都不会发生')
      .not.toContain('aria-label="Unstage')
  })

  it('状态标签按 git 的两列各取所需：暂存看 index，未暂存看 worktree', () => {
    // 每一行的 index 与 worktree **刻意不同**：读错那一列就必然落进 switch 的 default（"Changed"），
    // 而不是恰好也对。两列填一样的值会让这条判据恒真。
    const markup = render([
      change('a.ts', { index: 'A', worktree: ' ', staged: true }),
      change('b.ts', { index: 'M', worktree: ' ', staged: true }),
      change('c.ts', { index: ' ', worktree: 'D', unstaged: true }),
      change('d.ts', { index: ' ', worktree: 'M', unstaged: true })
    ])

    const stagedGroup = group(markup, 'Staged')
    const changesGroup = group(markup, 'Changes')
    expect(stagedGroup).toContain('Added')
    expect(stagedGroup).toContain('Modified')
    expect(changesGroup).toContain('Deleted')
    expect(changesGroup).toContain('Modified')
    // 取反那一行后每条都会变成 "Changed"；这条钉住「没有任何一行退化」。
    expect(markup, '有行退化成泛化的 Changed——状态列读错了').not.toContain('>Changed<')
  })

  it('未跟踪的文件先按未跟踪判，不看两列状态码', () => {
    // untracked 在 changeLabel 里是**最先**判的（:22 早退），这条守那次早退：删掉它，git 给未跟踪
    // 文件的两列是 '??'，会落进 default 变成 "Changed"。
    const markup = render([change('new.ts', { index: '?', worktree: '?', untracked: true, unstaged: true })])
    expect(group(markup, 'Changes')).toContain('Untracked')
  })

  it('没有暂存内容时，消息框与提交按钮都关着', () => {
    // 界面不给出一条注定被拒的路：没有暂存内容时连消息都不让写。
    const markup = render([change('src/dirty.ts', { worktree: 'M', unstaged: true })])
    expect(markup).toContain('Stage a file to commit')
    expect(disabled(markup, 'textarea'), '没有暂存内容却让人写提交消息').toBe(true)
    expect(disabled(markup, 'submit'), '没有暂存内容却让人点提交').toBe(true)
  })

  /**
   * 有暂存内容时**只有消息框打开**，按钮仍关着——因为按钮多一个合取项 `!commitMessage.trim()`。
   *
   * 这条与上一条合起来把两个 `disabled` 表达式的**差别**钉住了，而不只是「有没有 disabled」：
   * - 把 textarea 的 `staged.length === 0` 删掉 → 上一条的 textarea 断言红；
   * - 把按钮的 `staged.length === 0` 删掉 → 上一条的按钮断言红；
   * - 把按钮的 `!commitMessage.trim()` 删掉 → 这一条的按钮断言红（空消息也能点，提交必被服务端拒）。
   * 三个合取项各自成为某一条断言现场里唯一还站着的守卫。
   */
  it('有暂存内容时消息框打开，但空消息仍点不了提交', () => {
    const markup = render([change('src/staged.ts', { index: 'M', staged: true })])
    expect(markup).toContain('Commit (1)')
    expect(disabled(markup, 'textarea'), '有暂存内容却不让写提交消息').toBe(false)
    expect(disabled(markup, 'submit'), '消息还是空的就让人点提交——这一次提交注定被拒').toBe(true)
  })
})

/**
 * 写操作面剩下那 5 个方法的入口（#206）。
 *
 * 在场事实：`preload/index.ts` 的 git 面暴露 10 个方法，其中 `unstage` / `discard` / `push` / `pull` /
 * `fetch` 在整个 renderer 里**零调用**。main 侧全部实现完整（`git-service.ts` 里 `restore --staged`、
 * `clean --force`、`--set-upstream`、以及把远端失败分成 5 个 kind 并脱敏），`git-remote-outcome.ts` 的
 * 两个纯函数也写好了、同样零生产消费者。也就是说这一族的每一层都在场，只差最后那个按钮。
 *
 * 这一族的判据必须落在**取值关系**上而不是文本在场，因为「按钮画出来了」与「按钮接对了」是两件能
 * 各自独立坏掉的事，而后者坏掉时前者一条都不红：
 *   - 三个远端动作各自把**自己**的动词喂进 describeGitRemote（写死一个字面量则三个按钮说同一句话，
 *     而 markup 上三个按钮照旧齐全——记忆 declared-capability-silently-not-done 的同族，#330 那条
 *     「唯一调用点传的是硬编码字面量」就是这个形状）；
 *   - 成功与失败去**两个不同**的写入口（都写 setActionError 则远端成功被画成红色横幅，而
 *     describeGitRemote 分两个形状的理由白做）；
 *   - 丢弃经 discardIntent 判，不是自己手抄一次比较（手抄的那一份与显示态各算一次必漂移）。
 */
describe('Source Control 的写操作面接线（#206）', () => {
  it('三个远端动作都有入口，忙态条件不是恒真', () => {
    const markup = render([change('src/staged.ts', { index: 'M', staged: true })])
    // 三个动词各有一个按钮。少任何一个，那条 main 侧实现就仍然只有 IPC 通道没有人类入口。
    for (const label of ['Fetch from remote', 'Pull from remote', 'Push to remote']) {
      expect(markup, `没有「${label}」入口——main 侧实现照旧零调用者`).toContain(
        `aria-label="${label}"`
      )
    }
    // 三个按钮在「没有任何动作在跑」时必须都是开着的。这条钉住忙态那个条件不是恒真——写死
    // `disabled` 或把条件取反都让三个入口永久点不动，而上面那条 aria-label 断言照旧全绿。
    //
    // 刻意**不**声称「远端忙态与逐行忙态各自独立」：renderToStaticMarkup 不跑 effect，这里没有
    // 办法把任一忙态置起来，所以那句话在这个现场无从观察（记忆 comment-promises-more-than-assertion：
    // 注释承诺的判据比断言强，比没有注释更坏）。真要守那一条得先有能挂载的测试环境（#204）。
    for (const label of ['Fetch from remote', 'Pull from remote', 'Push to remote']) {
      const at = markup.indexOf(`aria-label="${label}"`)
      const openTag = markup.slice(markup.lastIndexOf('<button', at), markup.indexOf('>', at))
      expect(openTag.includes('disabled=""'), `${label} 在没有动作在跑时就是关着的`).toBe(false)
    }
  })

  /**
   * **每个远端分支喂给 describeGitRemote 的是它自己那个动词。**
   *
   * 这条是这一族最容易静默坏掉的一处。`describeGitRemote` 的整张表是按 (动作, kind) 这一对索引的，
   * 因为同一个 kind 在不同动作下下一步相反（push 的 `no-upstream` 是「去 checkout 一个分支」，
   * pull 的同一个 kind 是「先 Push」）。而唯一调用点如果传一个字面量 `'push'`，类型合法、上面
   * 那条按钮断言全绿、`git-remote-outcome.test.ts` 那 25 条更是全绿（它直接调纯函数），
   * 于是点 Pull 失败时界面告诉你去 pull——正好相反。#330 记的就是这个形状。
   *
   * 判据落在实参的**形状**上：它必须是那个动词参数本身，不能是字面量。同时钉住调用点恰好一个——
   * 三个动词各写一次 describeGitRemote 时，这条判据只质询到其中一个（记忆
   * duplicated-rule-defeats-the-fix）。
   */
  it('远端结果翻译收到的动词是那次动作自己的，不是写死的字面量', () => {
    const sites = callSites('describeGitRemote')
    expect(
      sites.length,
      `describeGitRemote 的调用点是 ${sites.length} 个，应恰好 1 个——` +
        '三个动词各自翻一次时，下面那条形状判据只质询到其中一个'
    ).toBe(1)
    const [verbArgument, resultArgument] = sites[0]!
    expect(sites[0]!.length, 'describeGitRemote 的实参个数变了，判据要跟上').toBe(2)
    // 不能是字面量。`'push'` / `"push"` / 模板串都在这里红。
    expect(
      /^['"`]/.test(verbArgument),
      `describeGitRemote 的第一实参是字面量 \`${verbArgument}\`——三个按钮的失败提示会说同一句话，` +
        '而它们的下一步恰好相反（push 的 no-upstream 是 checkout，pull 的是 push）'
    ).toBe(false)
    // 且必须是那个动词入参本身，而不是另算一次（比如从某个 state 读）。runRemote 的形参名就是它。
    expect(
      verbArgument,
      `describeGitRemote 收到的第一实参是 \`${verbArgument}\`，不是 runRemote 的动词入参`
    ).toBe('verb')
    expect(
      resultArgument,
      `describeGitRemote 的第二实参是 \`${resultArgument}\`，不是那次桥调用的返回值`
    ).toBe('result')
  })

  /**
   * 三个动词各自调**自己**那个桥方法。
   *
   * 与上一条正交：动词传对了，而三条分支全都 `await lookup.bridge.push(...)`，那么点 Fetch 会真的
   * 推上去——一个破坏性动作冒充成一个只读动作，且回执还会说「Fetched」（因为动词是对的）。
   * tsc 沉默（三个方法签名兼容），markup 与上面那条断言全绿。
   *
   * 判据是「桥上被调到的远端方法名恰好是那三个，各一次」，而不是枚举某个具体分支的写法：
   * 三元、switch、查表都该被接受，「少了一个」或「同一个调了两次」则红。
   */
  it('三个远端动词各调自己那个桥方法，没有一个被顶替', () => {
    const called: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const target = node.expression.expression.getText(PANEL_AST)
        const method = node.expression.name.getText(PANEL_AST)
        if (/\bbridge$/.test(target)) called.push(method)
      }
      ts.forEachChild(node, walk)
    }
    ts.forEachChild(PANEL_AST, walk)
    // 自检：取值器真的抓到了桥调用，否则下面那条在空数组上会退化。
    expect(called.length, '一个 bridge 方法调用都没抓到——取值器失效，下面那条判据是死代码').toBeGreaterThan(0)
    const VERBS: GitRemoteVerb[] = ['push', 'pull', 'fetch']
    for (const verb of VERBS) {
      const count = called.filter((method) => method === verb).length
      expect(
        count,
        `桥上的 ${verb}() 被调了 ${count} 次，应恰好 1 次——0 次说明那个按钮接到了别的方法上` +
          '（点 Fetch 真的 push 出去，而回执照旧说 Fetched）'
      ).toBe(1)
    }
    // 本地那三个也要各自在场：unstage / discard 是这一轮补的入口，stage 是既有的。
    for (const method of ['stage', 'unstage', 'discard'] as const) {
      expect(
        called.filter((name) => name === method).length,
        `桥上的 ${method}() 没有被调——那条 main 侧实现仍然零调用者`
      ).toBe(1)
    }
  })

  /**
   * 成功与失败去**两个不同**的写入口。
   *
   * `GitRemoteOutcome` 刻意分两个形状（见 git-remote-outcome.ts 的注释）：成功那句是回执、失败那句是
   * 要处理的错误，两者在界面上去的地方不同。把 `if (outcome.ok)` 两侧都写成 `setActionError`，
   * 类型合法、上面每一条都绿，而用户 push 成功时看到一条红色错误横幅。
   *
   * 判据落在「两侧调的不是同一个 setter」上，而不是钉死某两个名字：改名重构不该误红，而把两侧
   * 写成同一个必红。
   */
  it('远端成功与失败写进两个不同的面，不是同一个', () => {
    const body = functionBody('runRemote')
    expect(body, 'runRemote 不见了——这一族的接线整段没了').not.toBeNull()
    // 取那个 `if (outcome.ok) … else …` 的两侧各自调了哪些 setter。
    let branches: { whenOk: string[]; whenNot: string[] } | null = null
    const setterNamesIn = (node: ts.Node): string[] => {
      const names: string[] = []
      const walk = (child: ts.Node): void => {
        if (ts.isCallExpression(child)) {
          const callee = child.expression.getText(PANEL_AST)
          if (/^set[A-Z]/.test(callee)) names.push(callee)
        }
        ts.forEachChild(child, walk)
      }
      walk(node)
      return names
    }
    const walk = (node: ts.Node): void => {
      if (
        ts.isIfStatement(node) &&
        /\boutcome\.ok\b/.test(node.expression.getText(PANEL_AST)) &&
        node.elseStatement
      ) {
        branches = {
          whenOk: setterNamesIn(node.thenStatement),
          whenNot: setterNamesIn(node.elseStatement)
        }
      }
      ts.forEachChild(node, walk)
    }
    ts.forEachChild(PANEL_AST, walk)
    expect(
      branches,
      '找不到按 outcome.ok 分岔且带 else 的语句——成功与失败没有分开处理，' +
        'describeGitRemote 分两个形状的理由白做'
    ).not.toBeNull()
    const { whenOk, whenNot } = branches!
    expect(whenOk.length, '成功那一侧没有写进任何面——远端成功后界面上什么都不显示').toBeGreaterThan(0)
    expect(whenNot.length, '失败那一侧没有写进任何面——远端失败被静默吞掉').toBeGreaterThan(0)
    // 两侧的写入口不能有交集。都写 setActionError（成功画成红横幅）或都写 setActionNotice
    // （失败画成一条平静的回执）在这里都红。
    const shared = whenOk.filter((name) => whenNot.includes(name))
    expect(
      shared,
      `成功与失败写进了同一个面（${shared.join(' / ')}）——远端成功被当成错误显示，或反之`
    ).toEqual([])
  })

  /**
   * 那两个面在渲染层都**真的有出口**。
   *
   * 上一条守「写进了两个不同的 state」，这条守「那两个 state 有人读」。少了这条，把
   * `actionNotice` 那个横幅整段删掉——两侧照旧写两个不同的 setter，上一条全绿，而远端成功后
   * 屏幕上什么都不会出现（记忆 extracting-to-lib-only-fixes-half：内容那一半好了，壳里有没有
   * 执行到照旧无人守）。
   *
   * 判据用**渲染结果**而不是源码文本：state 名会重构，而「成功的那句话出现在页面上」不会。
   */
  it('远端成功的回执与失败的横幅在页面上是两个不同的元素', () => {
    const markup = render([change('src/staged.ts', { index: 'M', staged: true })])
    // 两个面都有各自的渲染出口，且 role 不同：回执不抢焦点（`status`），失败要抢（`alert`）。
    // 合成一个元素就得在渲染期再判一次成败，而那个判断已经在 describeGitRemote 里做过了。
    expect(
      PANEL_SOURCE,
      '成功回执没有自己的渲染出口——远端成功后屏幕上什么都不出现'
    ).toMatch(/actionNotice\s*\?/)
    expect(PANEL_SOURCE, '失败横幅没有自己的渲染出口').toMatch(/actionError\s*\?/)
    const noticeAt = PANEL_SOURCE.indexOf('actionNotice ?')
    const errorAt = PANEL_SOURCE.indexOf('actionError ?')
    const noticeRole = /role="(\w+)"/.exec(PANEL_SOURCE.slice(noticeAt, noticeAt + 400))?.[1]
    const errorRole = /role="(\w+)"/.exec(PANEL_SOURCE.slice(errorAt, errorAt + 400))?.[1]
    expect(noticeRole, '成功回执那个元素没有 role').toBeDefined()
    expect(errorRole, '失败横幅那个元素没有 role').toBeDefined()
    expect(
      noticeRole,
      `两个面用了同一个 role（${noticeRole}）——一句回执会像错误一样抢走焦点，或一条失败被读成平静的提示`
    ).not.toBe(errorRole)
    // 判别器在场：现场两个面都是空的，所以两句话都不该出现在页面上。这条钉住上面读的不是
    // 一个恒真的源码片段——真渲染出来时它们是条件渲染而不是无条件常驻。
    expect(markup, '没有任何远端动作跑过，却已经在页面上显示回执').not.toContain(
      GIT_REMOTE_SUCCESS.push
    )
  })

  /**
   * 丢弃是**两步**，且那一步判定经 discardIntent，不是组件自己手抄一次比较。
   *
   * `discard` 对未跟踪文件在 main 侧走 `git clean --force`——从磁盘删除、无 reflog、不可撤销，
   * 而那个按钮就挨在 Stage 旁边。所以「不可能一次点击就删掉文件」必须是一条能被质询的断言。
   *
   * 判据两条：
   *   - 那次判定经 discardIntent（手抄 `armedDiscard === change.path` 在类型上合法，而它与显示态
   *     各算一次必漂移——按钮上写着「再点一次就删」而那次点击去的是武装分支，用户永远删不掉）；
   *   - 且**显示态与动作读同一个决定**：两处调用都在，各自一次。
   */
  it('丢弃经 discardIntent 判，且显示态与动作读同一个决定', () => {
    const sites = callSites('discardIntent')
    // 两个消费者：点击时决定「武装还是执行」，渲染时决定「这一行是不是武装态」。少一个就意味着
    // 那一侧自己手抄了一次比较。
    expect(
      sites.length,
      `discardIntent 的调用点是 ${sites.length} 个，应恰好 2 个（动作侧 + 显示侧）——` +
        '少一个说明那一侧手抄了比较，两侧一旦漂移，按钮说的与点击做的就不是一件事'
    ).toBe(2)
    for (const [armed, clicked] of sites) {
      expect(armed, `discardIntent 的第一实参是 \`${armed}\`，不是被武装的那一行`).toBe('armedDiscard')
      expect(
        clicked,
        `discardIntent 的第二实参是 \`${clicked}\`，不是这一行的 path——武装态会按别的东西判`
      ).toMatch(/\.path$/)
    }
    // 每一处**读**它的地方都必须是那次判定的实参。判据写成正向而不是「`armedDiscard ===` 这个
    // 形状不在场」：那种禁止形状的判据既漏（`!==`、反着写、`[x].includes(y)` 全绕过）又误伤
    // （本文件注释里写下那个反例就当场打红，我实测中过一次）。记忆 forbidden-shape-guard-misfires。
    const reads = readsOf('armedDiscard', PANEL_SOURCE, 'ChangesPanel.tsx')
    expect(reads.length, 'armedDiscard 一次都没被读到——取值器失效，下面那条是死代码').toBeGreaterThan(0)
    for (const read of reads) {
      expect(
        /^discardIntent\(/.test(read),
        `armedDiscard 在 \`${read}\` 里被直接读了，没经过 discardIntent——` +
          '那是同一个判定的第二份手抄，两份一旦漂移，按钮说的与点击做的就不是一件事'
      ).toBe(true)
    }
    // 自检：取值器认得出该拒的拼法，也认得出正确的那种。否则「没找到违规」与「认不出违规」同形。
    const rejected = 'const armed = armedDiscard === change.path'
    expect(
      readsOf('armedDiscard', rejected).some((read) => /^discardIntent\(/.test(read)),
      '取值器把一次手抄的比较也当成经过判定了——那正是它要挡的形状'
    ).toBe(false)
    const accepted = "const armed = discardIntent(armedDiscard, change.path) === 'discard'"
    expect(
      readsOf('armedDiscard', accepted).every((read) => /^discardIntent\(/.test(read)),
      '取值器认不出正确的写法——它挡的不是坏形状而是所有形状'
    ).toBe(true)
  })

  /**
   * 武装态在界面上**看得出来**。
   *
   * 两步判定本身守住了「不会一次点击就删」，但如果武装前后按钮长得一模一样，那两步对用户就只是
   * 「点了一下没反应，再点一下文件不见了」——闸在，可它不告诉任何人自己在。
   *
   * 判据是那个按钮的 aria-label 在两态下不同：这是屏幕上与读屏软件上都能观察到的那一层。
   * 用 AST 取那个条件表达式并判两侧不等，而不是钉某句具体文案（文案是设计的自由）。
   */
  it('丢弃按钮在武装态与未武装态说的不是同一句话', () => {
    const markup = render([change('src/dirty.ts', { worktree: 'M', unstaged: true })])
    // 未武装时（现场就是）说的是 Discard。
    expect(markup, '未暂存的文件没有丢弃入口——main 侧的 discard 仍然零调用者').toContain(
      'aria-label="Discard src/dirty.ts"'
    )
    // 已暂存那一族不给丢弃：先退回暂存区，再决定要不要丢。给了就意味着一次点击能跨过两个决定。
    const staged = render([change('src/staged.ts', { index: 'M', staged: true })])
    expect(
      group(staged, 'Staged'),
      '已暂存的文件也给了丢弃入口——那一步跨过了「先退回暂存区」这个决定'
    ).not.toContain('aria-label="Discard')

    // 两态的 label 必须不同。按 AST 取那个三元的两侧，判它们不是同一句。
    let labels: { armed: string; idle: string } | null = null
    const walk = (node: ts.Node): void => {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(PANEL_AST) === 'aria-label' &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isConditionalExpression(node.initializer.expression) &&
        /\barmed\b/.test(node.initializer.expression.condition.getText(PANEL_AST))
      ) {
        labels = {
          armed: node.initializer.expression.whenTrue.getText(PANEL_AST),
          idle: node.initializer.expression.whenFalse.getText(PANEL_AST)
        }
      }
      ts.forEachChild(node, walk)
    }
    ts.forEachChild(PANEL_AST, walk)
    expect(
      labels,
      '丢弃按钮的 aria-label 不按武装态分岔——两态长得一样，那道闸不告诉任何人自己在'
    ).not.toBeNull()
    expect(
      labels!.armed.trim(),
      '武装态与未武装态的 label 逐字相同，等于没有分岔'
    ).not.toBe(labels!.idle.trim())
  })
})
