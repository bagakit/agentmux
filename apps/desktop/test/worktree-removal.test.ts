import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  nextAfterWorktreeRemoval,
  worktreeRemovalEffect,
  worktreeRemovalPrompt,
  type WorktreeRemovalRequest
} from '../src/renderer/src/lib/worktree-removal-request.js'

/**
 * 单条 worktree 移除（#335）。后端的 `removeWorktree` 早就在场，但此前只被批量收尾调用，界面上
 * 没有任何入口——用户只能靠 fan-out 的胜负收尾顺带删掉一个。
 *
 * 这个文件守两件事，而两件事都不是「函数返回了什么」：
 *
 * 1. **两次确认必须问的是两件不同的事。** 第一次问「要删这个签出吗」，第二次问「git 说这里有未提交
 *    的改动，还是要丢掉吗」。本仓栽过的坑是措辞近似吃掉分类：两句话长得一样，用户就把第二次读成
 *    「我刚才不是确认过了吗」，于是顺手点掉别人几小时的产出。所以判据是**两段正文的实词无交集**，
 *    不是「两段不逐字相等」——`not.toBe` 在「确定要删吗？」对「真的确定要删吗？」上照旧通过。
 *
 * 2. **「按钮上写什么」和「请求里带什么」必须是同一次决定。** 分两处算必然漂移成「按钮说要丢弃、
 *    请求没带 discardChanges」——那时用户以为自己授权了丢弃，实际什么也没发生（或者反过来，更糟）。
 *    行为层守不住这条：两处各自都能算对。所以第二组是结构判据（AST）：`worktreeRemovalPrompt` 在
 *    面板里**只被调一次**，且对话框的文案与发出去的实参都引用那一次的结果。
 */

const PANEL = new URL('../src/renderer/src/components/BranchesPanel.tsx', import.meta.url)
const MENU = new URL('../src/renderer/src/components/BranchContextMenu.tsx', import.meta.url)

/** git 的原话在测试里用一个不可能与我们自己措辞撞车的哨兵，这样「原样带出」和「实词无交集」能分开判。 */
const REASON = 'ZZREASONZZ'

function request(overrides: Partial<WorktreeRemovalRequest> = {}): WorktreeRemovalRequest {
  return {
    workspaceId: 'ws-7',
    branch: 'lane-3',
    path: '/tmp/repo-lane-3',
    stage: { kind: 'confirm' },
    ...overrides
  }
}

/**
 * 显式列出停用词，而不是「短词都不算」。
 *
 * 为什么要显式：交集判据的强度全在这张表上。表越宽，两段话越容易"无交集"，最后退化成恒真。所以
 * 这里只放真正的功能词，并在下面用一条断言钉住过滤后两侧都还剩得下东西——否则这条守卫会在某次
 * 改文案后静默变成空对空。
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'be', 'is', 'it', 'its', 'itself', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'with', 'you', 'your'
])

function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
    if (raw.length === 0) continue
    if (STOP_WORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

describe('worktree 移除的两次确认', () => {
  it('两段正文的实词无交集：第二次问的是另一件事，不是同一句话再来一遍', () => {
    const confirm = worktreeRemovalPrompt(request())
    const blocked = worktreeRemovalPrompt(request({ stage: { kind: 'blocked', reason: REASON } }))

    // 分支名与 git 原话都是**外来数据**，不是我们撰写的措辞，比较前剔掉；留着它们会让判据取决于
    // 分支叫什么，而那不是这条守卫想说的事。
    const authored = (text: string): Set<string> => {
      const words = contentWords(text)
      for (const foreign of [...contentWords('lane-3'), ...contentWords(REASON)]) {
        words.delete(foreign)
      }
      return words
    }

    const left = authored(confirm.description)
    const right = authored(blocked.description)

    // 自检：过滤后两侧都得剩下实词，否则交集为空是因为没东西可比，判据是恒真的。
    expect(left.size, '第一段正文过滤后没剩下实词——交集判据会恒真').toBeGreaterThanOrEqual(2)
    expect(right.size, '第二段正文过滤后没剩下实词——交集判据会恒真').toBeGreaterThanOrEqual(2)

    const shared = [...left].filter((word) => right.has(word))
    expect(
      shared,
      '两个阶段的正文共用了实词。用户会把第二次读成第一次的重复，从而顺手丢弃未提交的产出'
    ).toEqual([])

    // 标题同理：用户先看到的是标题，两个阶段的标题若共用实词，正文的区别就来不及起作用。
    const titleShared = [...authored(confirm.title)].filter((word) =>
      authored(blocked.title).has(word)
    )
    expect(titleShared, '两个阶段的标题共用了实词').toEqual([])
  })

  it('被拒时把 git 的原话原样带出，不压平成我们自己的说法', () => {
    const blocked = worktreeRemovalPrompt(request({ stage: { kind: 'blocked', reason: REASON } }))
    // 用户需要的正是 git 那句话里的细节：哪个文件、暂存了还是未跟踪。换成「有未提交的改动」会把
    // 「先去看看」这条唯一有用的下一步抹掉。
    expect(blocked.description).toContain(REASON)
  })

  it('只有已经看过 git 理由的那一档才带 discardChanges，且措辞恰好点名它', () => {
    const confirm = worktreeRemovalPrompt(request())
    const blocked = worktreeRemovalPrompt(request({ stage: { kind: 'blocked', reason: REASON } }))

    expect(confirm.discardChanges, '第一次确认就带丢弃 = 脏树保护形同不存在').toBe(false)
    expect(blocked.discardChanges).toBe(true)

    // 两个方向各写一条。只守「带 discard 的那档要说 discard」时，把不带的那档也写上「Discard」
    // 仍然全绿——而那正是用户读错授权范围的形状。
    expect(blocked.confirmLabel.toLowerCase()).toContain('discard')
    expect(
      confirm.confirmLabel.toLowerCase(),
      '不丢弃的那一档在按钮上说了 discard：用户会以为自己已经授权丢弃'
    ).not.toContain('discard')
  })

  it('路径给用户核对，且两档都给', () => {
    const path = '/tmp/repo-lane-3'
    expect(worktreeRemovalPrompt(request()).subject).toBe(path)
    expect(
      worktreeRemovalPrompt(request({ stage: { kind: 'blocked', reason: REASON } })).subject
    ).toBe(path)
  })
})

describe('一次移除尝试之后往哪走', () => {
  it('git 确认删掉了就是结束，与当前在哪一档无关', () => {
    for (const stage of [
      { kind: 'confirm' } as const,
      { kind: 'blocked', reason: REASON } as const
    ]) {
      expect(
        nextAfterWorktreeRemoval(request({ stage }), {
          status: 'removed',
          removedPath: '/tmp/repo-lane-3',
          config: { projects: [], executors: [], hosts: [] } as never
        })
      ).toEqual({ kind: 'done' })
    }
  })

  it('第一次被拒不是错误，而是带着 git 的理由重问', () => {
    const next = nextAfterWorktreeRemoval(request(), { status: 'retained', reason: REASON })
    expect(next.kind).toBe('ask')
    if (next.kind !== 'ask') return
    expect(next.request.stage).toEqual({ kind: 'blocked', reason: REASON })
    // 重问的必须还是**同一个** worktree。把身份丢在这一步上，第二次点确认就会删到别的东西。
    expect(next.request.workspaceId).toBe('ws-7')
    expect(next.request.path).toBe('/tmp/repo-lane-3')
    expect(next.request.branch).toBe('lane-3')
  })

  it('已经选了丢弃还被拒，就是真失败——不能再问一次', () => {
    const next = nextAfterWorktreeRemoval(request({ stage: { kind: 'blocked', reason: 'first' } }), {
      status: 'retained',
      reason: 'second'
    })
    // 此时拒绝的原因一定不是脏树（用户已经授权丢弃了），而是权限/占用之类的真失败。继续 ask 会让
    // 用户在同一个对话框里无限点「Discard and Remove」，屏幕上什么也不变。
    expect(next).toEqual({ kind: 'failed', reason: 'second' })
  })
})

/**
 * 三种走向各自在屏幕上留下什么。
 *
 * 这一族此前**完全无人守**，而且不是"覆盖不足"而是结构上守不到：分派原本写在
 * `BranchesPanel.confirmRemoval` 的 if/else 里，而 desktop 的测试用 `renderToStaticMarkup`——它不跑
 * effect，更点不了对话框的确认键，所以那段代码没有任何东西执行它。实测把 `setActionError(next.reason)`
 * 改成 `setActionError(null)`，21 条断言与 tsc 全绿；而那个变异的症状是用户授权了丢弃、git 拒绝、
 * 对话框静静关掉什么也不说，用户以为删成功了（#399）。
 *
 * 所以判据落在纯函数上，且**三个字段各写一条**。只钉 `error` 那一格是不够的：`rescan` 在 `ask` 档
 * 变成 true 会把用户正在读的那句 git 理由刷掉，`removal` 在 `failed` 档不清空会让对话框留在屏上
 * 与错误条同时说两件相反的事。
 */
/**
 * 九个格子的实测（每次只改一件事，改完跑这四个 suite，再 cp 还原）：
 *
 * - `failed` 的 `error: next.reason` → `null`：**2 条红**（真失败那条 + 「只有一条报错」那条）。
 *   这正是抽成纯函数之前 21 条 + tsc 全绿存活的那个变异，现在它死了。
 * - `ask` 的 `rescan: false` → `true`：**2 条红**（重问那条 + 「只有一条重扫」那条）。
 *
 * 接线层（面板）另外两个方向：在面板里重新插一个 `next.kind === 'done'` 的分支、以及丢掉
 * `if (effect.rescan) await refresh()` 这一句转发，各**只红 AST 守卫那 1 条**。这就是分层的意义：
 * 壳的毛病不该靠九个格子的行为断言去抓，因为没有任何测试会执行那个壳。
 */
describe('三种走向落到屏幕上是什么样', () => {
  const effectOf = (next: Parameters<typeof worktreeRemovalEffect>[0]) => worktreeRemovalEffect(next)

  it('删成功：关对话框、不报错、重扫列表', () => {
    expect(effectOf({ kind: 'done' })).toEqual({ removal: null, error: null, rescan: true })
  })

  it('重问：对话框换成下一档的请求，不报错，且**不**重扫', () => {
    const asked = request({ stage: { kind: 'blocked', reason: REASON } })
    const effect = effectOf({ kind: 'ask', request: asked })
    // 对话框接下来显示的必须是那个推进过的请求本身——换成原请求，用户就永远读不到 git 的理由。
    expect(effect.removal).toBe(asked)
    // 保护生效不是错误。进错误条会让同一件事在屏幕上说两遍，且措辞是"失败"而非"需要你决定"。
    expect(effect.error, '把「需要你决定」报成了错误').toBeNull()
    // 什么都没删，重扫纯属多余——更糟的是它会让面板重渲染，把用户正在读的那句理由刷掉。
    expect(effect.rescan, '什么都没删却重扫列表，会刷掉用户正在读的 git 理由').toBe(false)
  })

  it('真失败：关对话框、把 git 原话报出去、不重扫', () => {
    const effect = effectOf({ kind: 'failed', reason: REASON })
    expect(
      effect.error,
      'git 的失败原话被吞掉了：对话框静静关掉，用户以为删成功了'
    ).toBe(REASON)
    expect(effect.removal, '报了错还留着对话框：屏幕上同时说两件相反的事').toBeNull()
    expect(effect.rescan, '什么都没删却重扫列表').toBe(false)
  })

  it('只有一条走向重扫，也只有一条走向报错', () => {
    // 逐格抄一遍上面三条就够松：把 `done` 也改成报错、或把三条都改成重扫，上面三条会红，但
    // 「恰好一条」这个形状本身没人守。这条钉的是那个形状——加第四种走向时，它必须自己回答
    // 「我算重扫的那一条吗」，而不是默默跟着某一档。
    const all = [
      effectOf({ kind: 'done' }),
      effectOf({ kind: 'ask', request: request({ stage: { kind: 'blocked', reason: REASON } }) }),
      effectOf({ kind: 'failed', reason: REASON })
    ]
    expect(all.filter((effect) => effect.rescan).length, '重扫的走向不是恰好一条').toBe(1)
    expect(all.filter((effect) => effect.error !== null).length, '报错的走向不是恰好一条').toBe(1)
  })
})

function parse(url: URL): ts.SourceFile {
  const path = url.pathname
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function callsTo(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return
    let callee: ts.Expression = node.expression
    // 括号包一层就绕过 isIdentifier 是本仓实测过的绕法，先剥掉。
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression
    const text = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null
    if (text === name) out.push(node)
  })
  return out
}

/** 某棵子树里出现的所有 `<object>.<property>` 拼法，用来问「这里读的是哪一个字段」。 */
function memberReads(node: ts.Node): Set<string> {
  const out = new Set<string>()
  walk(node, (child) => {
    if (!ts.isPropertyAccessExpression(child)) return
    if (!ts.isIdentifier(child.expression)) return
    out.add(`${child.expression.text}.${child.name.text}`)
  })
  return out
}

function attribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null {
  for (const property of element.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue
    if (property.name.getText() === name) return property
  }
  return null
}

function openingElements(source: ts.SourceFile, tag: string): ts.JsxOpeningLikeElement[] {
  const out: ts.JsxOpeningLikeElement[] = []
  walk(source, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    if (node.tagName.getText() === tag) out.push(node)
  })
  return out
}

describe('面板接线', () => {
  it('文案与实参出自同一次决定：worktreeRemovalPrompt 在面板里只被调一次', () => {
    const source = parse(PANEL)
    const calls = callsTo(source, 'worktreeRemovalPrompt')

    // 自检在前：调用数为 0 说明这条守卫已经在守一个不存在的东西（面板改用别的方式算文案了），
    // 那时「只调一次」也会以 0 通过。
    expect(calls.length, 'BranchesPanel 里没有 worktreeRemovalPrompt 调用——判据落空了').toBeGreaterThan(0)
    expect(
      calls.length,
      '算了不止一次。每一次都是一个能各自漂移的取值点，下一个人给某一档加条件时只会改到其中一处'
    ).toBe(1)

    // 那一次的结果必须绑到一个名字上，下面两条才有东西可指。
    let binding: string | null = null
    walk(source, (node) => {
      if (!ts.isVariableDeclaration(node)) return
      if (node.initializer === undefined) return
      if (!callsTo(node.initializer as unknown as ts.SourceFile, 'worktreeRemovalPrompt').length) {
        // initializer 可能是三元/条件表达式，用同一个遍历器在子树里找。
        let found = false
        walk(node.initializer, (child) => {
          if (child === calls[0]) found = true
        })
        if (!found) return
      }
      if (ts.isIdentifier(node.name)) binding = node.name.text
    })
    expect(binding, '那次调用的结果没有绑到一个名字上，无法证明各处取的是同一份').not.toBeNull()

    // 对话框在场，且它的文案取自那个名字——这同时证明了「对话框真的被渲染」。此前的形状是面板
    // 只 setRemoval 而没人渲染，整个功能是死的：点菜单毫无反应。
    const dialogs = openingElements(source, 'ConfirmationDialog')
    expect(dialogs.length, '没有渲染 ConfirmationDialog——点了菜单不会有任何反应').toBe(1)
    const dialog = dialogs[0]!
    for (const name of ['title', 'description', 'confirmLabel']) {
      const attr = attribute(dialog, name)
      expect(attr, `对话框缺 ${name}`).not.toBeNull()
      expect(
        attr!.getText().includes(binding!),
        `对话框的 ${name} 不是从那次决定取的，而是自己另算了一份`
      ).toBe(true)
    }

    // 发出去的实参也取那个名字。按钮上的话和请求里的值分两处算，就是「按钮说丢弃、请求没带」。
    const removeCalls = callsTo(source, 'removeWorktree')
    expect(removeCalls.length, '面板里没有 removeWorktree 调用').toBe(1)
    expect(
      removeCalls[0]!.getText().includes(`${binding}.discardChanges`),
      'discardChanges 不是从确认键那句话算出来的同一份'
    ).toBe(true)
  })

  it('删的是右键那一行的 worktree，不是当前打开的项目', () => {
    const source = parse(PANEL)
    const menus = openingElements(source, 'BranchContextMenu')
    expect(menus.length, '面板里没有 BranchContextMenu').toBe(1)
    const handler = attribute(menus[0]!, 'onRemoveWorktree')
    expect(handler, '菜单没有接 onRemoveWorktree').not.toBeNull()

    const reads = memberReads(handler!)
    // `branch.workspaceId` 与 `workspace.id` 只在「右键的正是自己那一行」时恰好一致，而那种偶然
    // 一致会把一个删错对象的 bug 藏起来：右键别的分支，删掉的是当前打开的这个。
    expect(reads.has('branch.workspaceId'), '没有从行记录上取 workspaceId').toBe(true)
    expect(
      reads.has('workspace.id'),
      '从当前打开的 workspace 取 id：右键别的分支会删错对象'
    ).toBe(false)
  })

  /**
   * 面板里那段分派**只是转发**：`worktreeRemovalEffect` 的三个字段各自无条件落到一处 setter。
   *
   * 为什么要单独钉这一条：上面那族把「三种走向各自该长什么样」搬进了纯函数，于是内容可判了——但
   * 「这个壳有没有被执行到、有没有偷偷自己再判一次」照旧无人守（本仓 extracting-to-lib-only-fixes-half
   * 那一族：搬完再在壳里插一个早退，行为测试全绿）。所以这里判的是壳的形状：
   *
   * - `worktreeRemovalEffect` 只调一次（多一次就是多一个能漂移的取值点）；
   * - 那次结果绑到一个名字上，三个字段都从它取；
   * - 那段函数体里**没有任何 if/三元**读 `next.kind`／`outcome.status`——面板自己再判一次分类，就是
   *   两处对同一件事各判一次，而其中一处永远没人执行。
   */
  it('面板只转发那次决定，不自己再判一次分类', () => {
    const source = parse(PANEL)
    const calls = callsTo(source, 'worktreeRemovalEffect')
    expect(calls.length, '面板里没有 worktreeRemovalEffect 调用——判据落空了').toBe(1)

    // 找到包住那次调用的函数体，只在**它**里面判形状：整份文件里当然还有别的 if。
    let body: ts.Node | null = null
    walk(source, (node) => {
      if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isMethodDeclaration(node)) return
      if (node.body === undefined) return
      let holds = false
      walk(node.body, (child) => {
        if (child === calls[0]) holds = true
      })
      // 取**最内层**那个：外层的组件函数也包着它，但那里 if 遍地都是。
      if (holds && (body === null || node.body.getStart() > body.getStart())) body = node.body
    })
    expect(body, '找不到包住那次调用的函数体').not.toBeNull()

    // 结果绑到一个名字上。
    let binding: string | null = null
    walk(body!, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return
      let found = false
      walk(node.initializer, (child) => {
        if (child === calls[0]) found = true
      })
      if (found && ts.isIdentifier(node.name)) binding = node.name.text
    })
    expect(binding, '那次决定的结果没绑到名字上，无法证明三个字段取的是同一份').not.toBeNull()

    // 三个字段都从那个名字取。少读一个就是那一格被面板自己另算了（或干脆丢了）。
    const reads = memberReads(body!)
    for (const field of ['removal', 'error', 'rescan']) {
      expect(
        reads.has(`${binding}.${field}`),
        `没有从那次决定取 ${field}：这一格要么被丢了，要么被面板自己另算了一份`
      ).toBe(true)
    }

    // 壳里不许出现按分类分岔的条件。`effect.rescan` 那个 if 是**转发布尔**不是判分类，所以判据
    // 落在「读了 next.kind / outcome.status 吗」上，而不是「有没有 if」。
    const text = body!.getText()
    for (const shape of ['.kind ===', '.kind !==', '.status ===', '.status !==']) {
      expect(
        text.includes(shape),
        `面板里出现了 \`${shape}\`：分类被判了第二次，而这一处没有任何测试执行它`
      ).toBe(false)
    }
  })

  it('没有 worktree 的分支不显示这一项（用缺席表达，不画禁用按钮）', () => {
    const source = parse(MENU)
    let guarded: ts.Expression | null = null
    walk(source, (node) => {
      if (!ts.isConditionalExpression(node)) return
      let holdsItem = false
      walk(node.whenTrue, (child) => {
        if (ts.isJsxText(child) && child.text.includes('Remove Worktree')) holdsItem = true
        if (ts.isStringLiteral(child) && child.text.includes('Remove Worktree')) holdsItem = true
      })
      if (holdsItem) guarded = node.condition
    })

    expect(guarded, '「Remove Worktree」不在任何条件里：没有 worktree 的分支也会看到它').not.toBeNull()
    expect(
      guarded!.getText(),
      '这一项的可见性不看 hasWorktree'
    ).toContain('hasWorktree')
  })
})
