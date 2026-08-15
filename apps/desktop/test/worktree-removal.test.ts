import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  nextAfterWorktreeRemoval,
  worktreeRemovalEffect,
  retainedLaneNotices,
  retainedLaneReport,
  retentionReport,
  worktreeRemovalPrompt,
  type WorktreeRemovalRequest
} from '../src/renderer/src/lib/worktree-removal-request.js'
import type { WorktreeRetention } from '../src/shared/contracts.js'

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

/**
 * 「已经问过 git、被拒了」那一档，写在一处。
 *
 * `retention` 是必填的，且默认给脏树那一档：只有它才有第二个问题可问（见
 * `nextAfterWorktreeRemoval`）。此前这些 fixture 只带一个 `reason`，于是三种保留原因在这一族测试里
 * 完全同形——而当时的实现也确实把它们同等对待，把 git 失败和「已删但记录没撤下」都弹成
 * 「Discard uncommitted work?」。fixture 的形状曾经就是那个缺陷的形状。
 */
function blockedStage(reason = REASON) {
  return { kind: 'blocked', retention: 'uncommitted-changes', reason } as const
}

/**
 * 三档保留的全集，写在测试自己这边。
 *
 * 刻意手抄而不是从实现导出一张表：从被测对象派生期望值，映射改窄时期望值跟着漂移，判据恒真
 * （本仓栽过的坑）。加第四档时这里会红——那正是要它红的时候，因为「新那档归哪边」是一次判断。
 */
const RETENTIONS = ['uncommitted-changes', 'git-failed', 'record-not-withdrawn'] as const

/** 一次「被留下」的结果。`retention` 必填，因为下一步完全由它决定。 */
function retained(retention: WorktreeRetention, reason = REASON) {
  return { status: 'retained', retention, reason } as const
}

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
  'that', 'the', 'this', 'to', 'was', 'were', 'with', 'you', 'your'
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
    const blocked = worktreeRemovalPrompt(request({ stage: blockedStage() }))

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
    const blocked = worktreeRemovalPrompt(request({ stage: blockedStage() }))
    // 用户需要的正是 git 那句话里的细节：哪个文件、暂存了还是未跟踪。换成「有未提交的改动」会把
    // 「先去看看」这条唯一有用的下一步抹掉。
    expect(blocked.description).toContain(REASON)
  })

  it('只有已经看过 git 理由的那一档才带 discardChanges，且措辞恰好点名它', () => {
    const confirm = worktreeRemovalPrompt(request())
    const blocked = worktreeRemovalPrompt(request({ stage: blockedStage() }))

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
      worktreeRemovalPrompt(request({ stage: blockedStage() })).subject
    ).toBe(path)
  })
})

describe('一次移除尝试之后往哪走', () => {
  it('git 确认删掉了就是结束，与当前在哪一档无关', () => {
    for (const stage of [
      { kind: 'confirm' } as const,
      blockedStage()
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
    const next = nextAfterWorktreeRemoval(request(), retained('uncommitted-changes'))
    expect(next.kind).toBe('ask')
    if (next.kind !== 'ask') return
    expect(next.request.stage).toEqual(blockedStage())
    // 重问的必须还是**同一个** worktree。把身份丢在这一步上，第二次点确认就会删到别的东西。
    expect(next.request.workspaceId).toBe('ws-7')
    expect(next.request.path).toBe('/tmp/repo-lane-3')
    expect(next.request.branch).toBe('lane-3')
  })

  it('已经选了丢弃还被拒，就是真失败——不能再问一次', () => {
    const next = nextAfterWorktreeRemoval(request({ stage: blockedStage('first') }), {
      ...retained('uncommitted-changes', 'second')
    })
    // 此时拒绝的原因一定不是脏树（用户已经授权丢弃了），而是权限/占用之类的真失败。继续 ask 会让
    // 用户在同一个对话框里无限点「Discard and Remove」，屏幕上什么也不变。
    expect(next).toEqual({ kind: 'failed', reason: 'second' })
  })

  /**
   * 只有脏树那一档能问出第二个问题。
   *
   * 三档保留此前在这一族里完全同形（fixture 只带一个 `reason`），而实现也确实把它们同等对待：
   * git 挂了、以及「已删但记录没撤下」，都会被推进到 `blocked` 阶段弹一个「Discard uncommitted
   * work?」。前者按下去只是再失败一次；**后者按下去更糟**——目录已经不在了，那次点击是去删一个不
   * 存在的路径，然后把「记录撤不下来」误报成一次 git 失败。
   *
   * 判据分成两条，因为它们能各自漂移：一条钉「哪些进 ask」，一条钉「哪些不进」。只写前者时把
   * `!== 'uncommitted-changes'` 那道闸删掉仍然全绿。
   */
  it('非脏树的保留不再问第二个问题，直接如实收场', () => {
    for (const retention of ['git-failed', 'record-not-withdrawn'] as const) {
      const next = nextAfterWorktreeRemoval(request(), retained(retention))
      expect(
        next,
        `${retention} 被推进到了「丢弃未提交产出？」那一屏，而这一档根本没有那个问题可问`
      ).toEqual({ kind: 'failed', reason: REASON })
    }
  })

  it('三档保留恰好一档能进 ask：加第四档时它必须自己回答归哪边', () => {
    // 上一条逐档抄一遍就够松——把脏树那档也改成 failed，上面两条照旧全绿，而那时脏树保护就再也
    // 问不出「要丢弃吗」了。这条钉的是那个形状本身。
    const asked = RETENTIONS.filter(
      (retention) => nextAfterWorktreeRemoval(request(), retained(retention)).kind === 'ask'
    )
    expect(asked, '能问出第二个问题的不是恰好「脏树」这一档').toEqual(['uncommitted-changes'])
  })

  it('推进到 blocked 时把分类一起带过去，第二屏不再自己猜一遍', () => {
    // 分类是服务层在失败现场定的。第二屏若自己按 `reason` 的措辞猜，git 换句话就静默失效。
    const next = nextAfterWorktreeRemoval(request(), retained('uncommitted-changes'))
    expect(next.kind).toBe('ask')
    if (next.kind !== 'ask') return
    expect(next.request.stage.kind).toBe('blocked')
    if (next.request.stage.kind !== 'blocked') return
    expect(next.request.stage.retention).toBe('uncommitted-changes')
  })

  it('丢弃对话框对非脏树响亮拒绝，而不是悄悄换套文案', () => {
    // 如果哪天路由回归了，问题在路由上。此时弹一个「丢弃产出？」的框比抛出来危险得多：
    // `record-not-withdrawn` 那档目录已经不在，按下去等于去删一个不存在的路径。
    for (const retention of ['git-failed', 'record-not-withdrawn'] as const) {
      expect(
        () => worktreeRemovalPrompt(request({ stage: { kind: 'blocked', retention, reason: REASON } })),
        `${retention} 悄悄拿到了一屏丢弃确认`
      ).toThrow(/only valid for uncommitted work/)
    }
    // 自检：脏树那一档必须仍然拿得到那一屏，否则上面两条是靠「谁来都抛」通过的。
    expect(() => worktreeRemovalPrompt(request({ stage: blockedStage() }))).not.toThrow()
  })
})

/**
 * 批量收尾之后那条横幅说的话。
 *
 * store 那一版把三档折成一句硬编码的「kept because they still hold changes」，对另外两档都是假话：
 * git 挂掉那档没有改动可言，而记录没撤下那档**目录已经被删了**，让用户去「review before discarding」
 * 是把他送去找一份不存在的产出。
 *
 * 判据分成三层，因为它们各自能漂移：措辞逐档点名（不是「三句都不一样」）、实词无交集（近似措辞会
 * 吃掉分类）、以及映射表的键必须是全集（加第四档时不许静默落到某一句上）。
 */
describe('批量收尾的分档告知', () => {
  const laneOf = (retention: WorktreeRetention, workspaceId: string, reason = REASON) => ({
    status: 'retained' as const,
    workspaceId,
    retention,
    reason
  })

  it('三档同时出现时各说自己那句话，不共用一条横幅', () => {
    const notices = retainedLaneNotices([
      { status: 'removed', workspaceId: 'ws-gone', removedPath: '/tmp/gone' },
      laneOf('git-failed', 'ws-b'),
      laneOf('uncommitted-changes', 'ws-a'),
      laneOf('record-not-withdrawn', 'ws-c')
    ])

    // 顺序写死在实现里（由「用户可以处理」到「需要有人来看一眼」），而不是跟着到达次序——「先说
    // 哪句」也是判断。这里的 fixture 刻意按乱序喂进去，所以这条断言同时钉住了那个决定。
    expect(notices.map((notice) => notice.retention)).toEqual([
      'uncommitted-changes',
      'git-failed',
      'record-not-withdrawn'
    ])
    expect(notices.map((notice) => notice.workspaceIds)).toEqual([['ws-a'], ['ws-b'], ['ws-c']])
    // `removed` 的 lane 不该出现在任何一条里：它没有任何事情要用户做。
    expect(notices.some((notice) => notice.workspaceIds.includes('ws-gone'))).toBe(false)
  })

  it('每一档的措辞恰好点名自己那一档收着的东西', () => {
    // 两个方向各一条。只守「每档都被点名」时，把映射改窄（比如三档共用脏树那句）仍然全绿——而那
    // 正是 store 里的原状。
    const message = (retention: WorktreeRetention) =>
      retainedLaneNotices([laneOf(retention, 'ws-1')])[0]!.message

    expect(message('uncommitted-changes')).toMatch(/uncommitted/i)
    // 这一档唯一不许说「kept」「remain」：两个词都在暗示目录还在，而它已经被删了。用户读到「kept」
    // 会去那个目录找产出。
    const gone = message('record-not-withdrawn')
    expect(gone).toMatch(/deleted/i)
    expect(gone.toLowerCase(), '「已删」那一档说了 kept/remain：用户会去找一个不存在的目录').not.toMatch(
      /\bkept\b|\bremain/
    )
    // git 失败那档：目录还在，但没有「未提交的改动」这回事。
    const gitFailed = message('git-failed')
    expect(gitFailed).toMatch(/Git/)
    expect(
      gitFailed.toLowerCase(),
      'git 失败被说成有未提交的改动：用户会去 review 一份根本不存在的产出'
    ).not.toContain('uncommitted')
  })

  it('git-failed 那句不许带删除动词——这一档的另一个生产者是「建」', () => {
    // 这一档现在有两个来源，做的是相反的动作：
    // - 删：git 拒绝移除（worktree-service 的 removeWorktree 路）
    // - 建：扇出时 git **建**成了 worktree、记录没落上（register 抛 git-failed，02acc703）
    // 两者都真实到达这句话：扇出的 launch-failed lane 带着 cleanup.retention 进 store 的
    // retentionReport。所以横幅里任何删除动词，套到建的那一侧都是假话。
    const created =
      'The worktree at /repo/.worktrees/lane-a was created, but recording it failed, so it is not registered: ENOSPC'
    const banner = retentionReport([{ retention: 'git-failed', id: 'lane-a', reason: created }])!

    // 旧措辞是 `Git refused to remove N worktree(s)`，于是整句读作「拒绝删除…: 这个 worktree 已经
    // 建好了」。这条断言就是钉死那个自相矛盾。
    expect(
      banner.toLowerCase(),
      '建成功那一侧被说成「删除被拒」：同一句话里既说没删掉又说已建好，用户无法判断盘上到底有没有东西'
    ).not.toMatch(/\bremove\b|\bremoval\b|\brefused\b/)
    // 反向：这一档真正成立的事必须还在，否则上面那条靠删字就能满足。
    expect(banner, '「什么都没被丢弃」是这一档唯一的承诺，不能连它一起删掉').toMatch(
      /nothing was discarded/i
    )
    // git 的原话原样带着——用户判断盘上有没有东西，全靠它。
    expect(banner).toContain(created)

    // 对照：删的那一侧读起来仍然通顺，措辞没有为了迁就建那侧而变得谁都不认。
    const removalBanner = retentionReport([
      { retention: 'git-failed', id: 'lane-b', reason: 'fatal: could not lock config file' }
    ])!
    expect(removalBanner).toContain('fatal: could not lock config file')
    expect(removalBanner).toMatch(/nothing was discarded/i)
  })

  it('三句话两两之间实词无交集：不是同一句话换个说法', () => {
    // `not.toBe` 在「kept because they hold work」对「kept because Git said no」上照旧通过，而那两句
    // 读起来是同一件事。判据落在实词集合上。
    const authored = (retention: WorktreeRetention) => {
      const words = contentWords(retainedLaneNotices([laneOf(retention, 'ws-1')])[0]!.message)
      // 计数、外来数据、以及每句都必然出现的领域词剔掉——留着它们会让交集恒不为空，判据变成恒假。
      for (const foreign of [...contentWords(REASON), ...contentWords('1 worktree s')]) {
        words.delete(foreign)
      }
      return words
    }

    for (const [left, right] of [
      ['uncommitted-changes', 'git-failed'],
      ['uncommitted-changes', 'record-not-withdrawn'],
      ['git-failed', 'record-not-withdrawn']
    ] as const) {
      const leftWords = authored(left)
      const rightWords = authored(right)
      // 自检：过滤后两侧都得剩下实词，否则交集为空是因为没东西可比。
      expect(leftWords.size, `${left} 过滤后没剩下实词——判据恒真`).toBeGreaterThanOrEqual(2)
      expect(rightWords.size, `${right} 过滤后没剩下实词——判据恒真`).toBeGreaterThanOrEqual(2)
      expect(
        [...leftWords].filter((word) => rightWords.has(word)),
        `${left} 与 ${right} 共用实词：用户分不出这两档要他做的事不一样`
      ).toEqual([])
    }
  })

  it('git 的原话原样带出，不压平成我们自己的说法', () => {
    // 用户唯一有用的下一步全在那句话里（哪个文件、什么权限、只读卷）。
    const notices = retainedLaneNotices([
      laneOf('git-failed', 'ws-1', 'ZZFIRSTZZ'),
      laneOf('git-failed', 'ws-2', 'ZZSECONDZZ')
    ])
    expect(notices).toHaveLength(1)
    expect(notices[0]!.workspaceIds).toEqual(['ws-1', 'ws-2'])
    // 两条都要带上：只带第一条时第二个 lane 的失败原因静默消失。
    expect(notices[0]!.message).toContain('ZZFIRSTZZ')
    expect(notices[0]!.message).toContain('ZZSECONDZZ')
  })

  it('没有保留的 lane 就不发横幅', () => {
    expect(
      retainedLaneNotices([{ status: 'removed', workspaceId: 'ws-1', removedPath: '/tmp/x' }])
    ).toEqual([])
  })

  /**
   * 分档告知能上屏的只有**一句**。
   *
   * store 的错误面是一个槽（`reportError` 就是 `set({ error })`），后一次调用覆盖前一次。此前两个
   * 消费者都是 `for (notice of ...) reportError(notice.message)`，于是三档同时出现时屏幕上只剩最后
   * 一条：按顺序排在第一位的脏树——唯一有真实下一步可做的那一档——被后面两档静默擦掉。
   *
   * 所以这一组的判据不是「返回了几条」，而是**每一档的正文都必须留在那一句里**。分组数组作为数据是
   * 对的（每档要用户做的事不同），能上屏的只有一句，折叠因此是一次判断，要在能被质询的地方。
   */
  it('三档折成一句时每一档都还在：一个错误槽装不下三次调用', () => {
    const collapsed = retainedLaneReport([
      laneOf('uncommitted-changes', 'ws-a', 'ZZDIRTYZZ'),
      laneOf('git-failed', 'ws-b', 'ZZGITZZ'),
      laneOf('record-not-withdrawn', 'ws-c', 'ZZRECORDZZ')
    ])

    // 自检：先确认这个 fixture 真的产出了三档，否则下面三条会因为「本来就只有一档」而恒真。
    expect(
      retainedLaneNotices([
        laneOf('uncommitted-changes', 'ws-a'),
        laneOf('git-failed', 'ws-b'),
        laneOf('record-not-withdrawn', 'ws-c')
      ])
    ).toHaveLength(3)

    for (const reason of ['ZZDIRTYZZ', 'ZZGITZZ', 'ZZRECORDZZ']) {
      expect(collapsed, `${reason} 那一档在折叠后消失了——它在屏幕上被后一档擦掉`).toContain(reason)
    }
    // 顺序仍然是那个顺序：脏树在最前，因为它是唯一能让用户马上做点什么的一档。
    expect(collapsed!.indexOf('ZZDIRTYZZ')).toBeLessThan(collapsed!.indexOf('ZZRECORDZZ'))
  })

  it('没有保留时折成 null，而不是空串', () => {
    // 空串在 `reportError` 那边会变成一条什么都没写的错误弹出来——比不报更糟。
    expect(retainedLaneReport([{ status: 'removed', workspaceId: 'ws-1', removedPath: '/tmp/x' }])).toBe(
      null
    )
  })

  it('扇出侧与批量侧折出同一句话：两处不许各排一次序', () => {
    // 两个消费者认 lane 的字段不同（workspaceId / 分支名），措辞与顺序必须完全一样。各写一遍 join
    // 就是三档措辞当初被折成一句硬编码的那个形状，只是换了个地方复发。
    const fanout = retentionReport([
      { retention: 'record-not-withdrawn', id: 'lane-c', reason: 'ZZRECORDZZ' },
      { retention: 'uncommitted-changes', id: 'lane-a', reason: 'ZZDIRTYZZ' }
    ])
    const batch = retainedLaneReport([
      laneOf('record-not-withdrawn', 'lane-c', 'ZZRECORDZZ'),
      laneOf('uncommitted-changes', 'lane-a', 'ZZDIRTYZZ')
    ])
    expect(fanout).toBe(batch)
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
    const asked = request({ stage: blockedStage() })
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
      effectOf({ kind: 'ask', request: request({ stage: blockedStage() }) }),
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

type ForwardingTail = {
  /** 那次决定绑到的名字。`null` = 没找到，判据落空。 */
  binding: string | null
  /** 绑定之后、同一个块里的语句里，不是「纯转发」的那些。 */
  offenders: string[]
  /** 绑定之后一共有几条语句。0 说明三句转发都不在了。 */
  tailLength: number
}

/**
 * 「壳只转发那次决定」这条不变量的判据，**整条**抽出来——包括找语句块那一步。
 *
 * 判据的形状是**白名单**：绑定之后的每条语句必须恰好是三种转发写法之一
 * （`f(b.x)` / `if (b.x) g()` / `if (b.x) await g()`）。除此之外一律记成违规。
 *
 * 为什么不是黑名单：此前这里禁的是「读 kind / status」，两版都被实测绕过——
 *   - 第一版禁算符字面量（`.kind ===` 之类），Yoda 式 `'failed' === x.kind` 整条绕过；
 *   - 第二版禁属性名（AST 上 `kind`/`status`），`const { kind } = next` 解构、`next['kind']`
 *     下标、把判断挪进块外的 helper、以及 `effect.rescan ? effect.error : null`
 *     ——最后这个连分类字段都不读，却因为 `rescan` 只在 `done` 时为真，
 *     恰好在真 `failed` 时算出 `null`，即 #399 那个「对话框静静关掉什么也不说」。
 *     而它藏在上一版注释亲手写下的「`rescan` 是转发布尔不是判分类」这句豁免里。
 *
 * 禁止清单要枚举拼法，所以永远漏；允许清单只有三条，多出来的任何东西都是违规。
 * 这也是源码那句「这里刻意一个 if 都没有…剩下的三句无条件赋值」真正在说的话。
 *
 * 只看**绑定之后**的语句，是因为绑定之前读分类是合法的：`discardChanges` 取的就是
 * 输入那一档的 `stage.kind`，早退检查读 `snapshot?.kind` 也没问题。上一版连这些一起禁，
 * 会对正确的改动报红——那种守卫下一个人会直接删掉。
 */
function forwardingTail(source: ts.SourceFile): ForwardingTail {
  const calls = callsTo(source, 'worktreeRemovalEffect')
  if (calls.length !== 1) return { binding: null, offenders: [], tailLength: 0 }

  let declaration: ts.VariableStatement | null = null
  walk(source, (node) => {
    if (!ts.isVariableStatement(node)) return
    let holds = false
    walk(node, (child) => {
      if (child === calls[0]) holds = true
    })
    if (holds) declaration = node
  })
  if (declaration === null) return { binding: null, offenders: [], tailLength: 0 }

  const statement: ts.VariableStatement = declaration
  const name = statement.declarationList.declarations[0]?.name
  const binding = name !== undefined && ts.isIdentifier(name) ? name.text : null
  if (binding === null) return { binding: null, offenders: [], tailLength: 0 }

  const block = statement.parent
  if (!ts.isBlock(block)) return { binding: null, offenders: [], tailLength: 0 }
  const tail = block.statements.slice(block.statements.indexOf(statement) + 1)

  /** 恰好是 `<binding>.<字段>`。解构后的裸名字、下标写法、三元、helper 调用都不算。 */
  const readsDecision = (expression: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === binding

  /** 无参调用（可带 await），即 `await refresh()`。带参数就得说清参数是什么，故不许。 */
  const isBareCall = (node: ts.Statement): boolean => {
    if (!ts.isExpressionStatement(node)) return false
    let expression = node.expression
    if (ts.isAwaitExpression(expression)) expression = expression.expression
    return ts.isCallExpression(expression) && expression.arguments.length === 0
  }

  const offenders: string[] = []
  for (const node of tail) {
    // `f(b.x)`：单参，且那个参数就是从那次决定取的一格。
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const args = node.expression.arguments
      if (args.length === 1 && readsDecision(args[0]!)) continue
    }
    // `if (b.x) g()`：条件就是那一格本身，没有 else，分支里是无参调用。
    if (ts.isIfStatement(node) && readsDecision(node.expression) && node.elseStatement === undefined) {
      if (isBareCall(node.thenStatement)) continue
    }
    offenders.push(node.getText())
  }
  return { binding, offenders, tailLength: tail.length }
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
    const tail = forwardingTail(parse(PANEL))
    expect(tail.binding, '那次决定的结果没绑到名字上，无法证明三个字段取的是同一份').not.toBeNull()

    // 三个字段都从那个名字取。少读一个就是那一格被面板自己另算了（或干脆丢了）。
    const reads = memberReads(parse(PANEL))
    for (const field of ['removal', 'error', 'rescan']) {
      expect(
        reads.has(`${tail.binding}.${field}`),
        `没有从那次决定取 ${field}：这一格要么被丢了，要么被面板自己另算了一份`
      ).toBe(true)
    }

    // 绑定之后只许有那三句转发。任何别的语句——三元、解构、下标、helper 调用、
    // 或者用 `rescan` 冒充分类——都会落到这里。判据是允许清单，不是禁止清单。
    expect(
      tail.offenders,
      '绑定之后出现了不是纯转发的语句：分类被判了第二次，而这一处没有任何测试执行它'
    ).toEqual([])
    expect(tail.tailLength, '绑定之后一条语句都没有，三句转发不在了').toBe(3)
  })

  it('自证：上一条的判据对四种绕法都报红（否则它只是换了个漏法）', () => {
    // 判据必须自己证一次认得出违规，而且要走**同一条** `forwardingTail`——包括找语句块那一步。
    // 只证「叶子谓词能在合成串里找到东西」是不够的：找块那一步一旦回归，真断言会因为
    // 拿到空清单而恒真变绿，而只验叶子的自证察觉不到。
    //
    // 这四种写法都重新引入 #399（真 failed 时对话框静默关闭、什么也不说），
    // 且前三种是历史上真的绕过过某一版判据的形状，第四种连分类字段都不读。
    const bypasses = {
      'Yoda 式算符（绕过字面量黑名单那版）':
        `setActionError('failed' === nextAfterWorktreeRemoval(removal, outcome).kind ? null : effect.error)`,
      '解构分类字段（绕过属性名黑名单那版）':
        `const { kind } = next\n      setActionError(kind === 'failed' ? null : effect.error)`,
      '下标取分类字段（同上）':
        `setActionError(next['kind'] === 'failed' ? null : effect.error)`,
      // rescan 只在 done 时为真，所以真 failed 时这句算出 null——即 #399，且不读任何分类字段。
      '拿 rescan 当分类用（上一版注释亲手豁免的那个字段）':
        `setActionError(effect.rescan ? effect.error : null)`
    }
    for (const [label, injected] of Object.entries(bypasses)) {
      const probe = ts.createSourceFile(
        'probe.tsx',
        `async function confirmRemoval() {
      const effect = worktreeRemovalEffect(nextAfterWorktreeRemoval(removal, outcome))
      setRemoval(effect.removal)
      ${injected}
      if (effect.rescan) await refresh()
    }`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )
      const tail = forwardingTail(probe)
      expect(tail.binding, `${label}：自证的探针本身没被判据认出来，探针写坏了`).toBe('effect')
      expect(
        tail.offenders.length,
        `判据放过了「${label}」——它是恒真的，或者只是换了个漏法`
      ).toBeGreaterThan(0)
    }
  })

  it('自证：判据不对绑定之前读分类字段报红（那是合法的）', () => {
    // 上一版把「读 kind / status」整条禁掉，于是三种正确的改动也报红：
    // 输入档的 `removal.stage.kind`、早退用的 `snapshot?.kind`、以及埋点里的 `outcome.status`。
    // 一个会对正确代码报红的守卫，下一个人会直接删掉——所以这一条钉住它不这么做。
    const legitimate = ts.createSourceFile(
      'probe.tsx',
      `async function confirmRemoval() {
      if (snapshot?.kind !== 'git-repository') return
      const outcome = await removeWorktree({ discardChanges: removal.stage.kind === 'blocked' })
      const effect = worktreeRemovalEffect(nextAfterWorktreeRemoval(removal, outcome))
      setRemoval(effect.removal)
      setActionError(effect.error)
      if (effect.rescan) await refresh()
    }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const tail = forwardingTail(legitimate)
    expect(tail.binding, '自证的探针本身没被判据认出来').toBe('effect')
    expect(tail.offenders, '判据对绑定之前合法地读分类字段报红了：它过宽，会误伤正确的改动').toEqual([])
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
