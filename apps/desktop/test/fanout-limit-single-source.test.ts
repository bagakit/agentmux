import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../src/shared/contracts.js'
import { MAX_FANOUT_LANES } from '../src/shared/fanout-limits.js'
import { planFanOut } from '../src/main/fanout-plan.js'
import { buildFanOutRequest } from '../src/renderer/src/lib/fanout-request.js'

// ---------------------------------------------------------------------------
// 扇出上限只有一个数（#218）。
//
// 这个天花板有两个执行面：surface 侧提前判一次（为了就地给出可读的拒绝理由，而不是让用户按下按钮
// 之后才被 main 否掉），main 侧作为权威再判一次。两处都必须判，但不许各记一个数。
//
// 此前就是各记一份，名字还不一样：`MAX_FANOUT`（main）与 `MAX_FANOUT_LANES`（surface）。名字不同
// 意味着 `tsc` 连「这两个该是同一件事」都不知道——改一处漏一处，编译器永远沉默。漂移之后用户看到的
// 是：填了个数、界面放行、请求走到底被拒绝，或者反过来 surface 拒绝了一个 main 本来接受的数。
//
// 所以主判据不是「常量只有一份」——换个名字手抄一份就绕过去了，而那正是当时的形态。主判据是
// **两个执行面对每一个 count 的裁决必须逐点一致**：漂移唯一的可观测形态就是它们在某个数上分岔。
// ---------------------------------------------------------------------------

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: {
      label: 'Codex',
      providerId: 'codex',
      command: 'codex',
      args: [],
      env: {},
      injectAgentMuxGuide: true
    }
  },
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true }
  }
}

/** main 侧接不接受这个 lane 数。 */
function mainAccepts(count: number): boolean {
  return (
    planFanOut({
      count,
      baseName: 'Add retry to the uploader',
      worktreeRoot: '/repo/.worktrees',
      executorIds: ['codex'],
      existingBranches: [],
      existingWorktreePaths: []
    }).kind !== 'rejected'
  )
}

/** surface 侧接不接受这个 lane 数。`single` 也是接受——一条 lane 走普通启动路径，不是错误。 */
function surfaceAccepts(count: number): boolean {
  return (
    buildFanOutRequest({ prompt: 'add retry to the uploader', count, config }).kind !== 'invalid'
  )
}

describe('两个执行面对上限逐点一致', () => {
  it('从 1 扫到上限 +3，main 与 surface 的裁决处处相同', () => {
    // 这是这个 feature 的全部内容。任何一侧的数字漂了，某个 count 上的两个布尔值就会分岔。
    const disagreements: string[] = []
    for (let count = 1; count <= MAX_FANOUT_LANES + 3; count += 1) {
      const main = mainAccepts(count)
      const surface = surfaceAccepts(count)
      if (main !== surface) {
        disagreements.push(
          `count=${count}：main ${main ? '接受' : '拒绝'} 而 surface ${surface ? '接受' : '拒绝'}`
        )
      }
    }
    expect(disagreements, [
      '两个执行面对同一个 lane 数判得不一样。用户能看到的形态是：界面放行、请求走到底才被否掉',
      '（或者反过来，界面拒绝了一个后端本来接受的数）。两侧都该从 src/shared/fanout-limits.ts 取值。'
    ].join('\n')).toEqual([])

    // 前提自检：这一扫必须真的跨过那条界，否则「处处相同」可以靠两侧都恒真而成立。
    expect(mainAccepts(MAX_FANOUT_LANES), '上限本身被拒——判据扫的区间不含接受侧').toBe(true)
    expect(mainAccepts(MAX_FANOUT_LANES + 1), '上限 +1 被接受——根本没有天花板').toBe(false)
  })

  it('两侧的拒绝理由都带上那个数', () => {
    // 拒绝时不说上限是多少，用户只能靠试。两处文案各自拼一份，所以各钉一次。
    const main = planFanOut({
      count: MAX_FANOUT_LANES + 1,
      baseName: 'x',
      worktreeRoot: '/repo/.worktrees',
      executorIds: ['codex'],
      existingBranches: [],
      existingWorktreePaths: []
    })
    if (main.kind !== 'rejected') throw new Error(`expected rejected, got ${main.kind}`)
    expect(main.reason).toContain(String(MAX_FANOUT_LANES))

    const surface = buildFanOutRequest({
      prompt: 'x y z',
      count: MAX_FANOUT_LANES + 1,
      config
    })
    if (surface.kind !== 'invalid') throw new Error(`expected invalid, got ${surface.kind}`)
    expect(surface.reason).toContain(String(MAX_FANOUT_LANES))
  })
})

describe('结构层：上限只在 shared 声明一次', () => {
  // 上面那组行为断言只覆盖今天在场的两个执行面。第三个面（比如某个新面板自己 clamp 一下滑杆）
  // 不会被它看见。所以再钉一层：**取值只能来自 import**。
  //
  // 判据取 import 关系而不是「不许出现字面量 8」——后者在这个仓里噪声太大，也管不住把 8 换成
  // 别的名字。谁提到这个概念，谁就必须从 SSOT import 它；SSOT 自己是唯一的声明点。
  const desktopSrc = new URL('../src/', import.meta.url).pathname
  const SSOT = 'shared/fanout-limits.ts'

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(desktopSrc, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel, out)
      else if (/\.tsx?$/u.test(entry.name)) out.push(rel)
    }
    return out
  }

  const files = walk('').map((rel) => ({
    rel,
    source: readFileSync(join(desktopSrc, rel), 'utf8')
  }))

  it('提到 MAX_FANOUT_LANES 的文件都是从 shared/fanout-limits import 的', () => {
    const mentions = files.filter(
      (file) => file.rel !== SSOT && file.source.includes('MAX_FANOUT_LANES')
    )

    // 前提自检：判据认得出这一族引用。数成 0 就是扫描根写错了，主断言会静默通过。
    expect(mentions.length, '一个引用都没扫到——扫描根写错，主断言恒绿').toBeGreaterThanOrEqual(3)

    const notImported = mentions
      .filter((file) => !/from '[^']*shared\/fanout-limits(\.js)?'/u.test(file.source))
      .map((file) => file.rel)
    expect(notImported, [
      '这些文件自己声明了扇出上限，而不是从 src/shared/fanout-limits.ts import。',
      '手抄一份就意味着 tsc 再也看不见两处漂移——尤其是抄成另一个名字的时候。'
    ].join('\n')).toEqual([])
  })

  it('SSOT 之外的扇出模块里没有裸的数字常量', () => {
    // 换个名字抄一份（当时就是 `MAX_FANOUT`）能绕过上一条：那个文件里没有 `MAX_FANOUT_LANES`
    // 这几个字。所以对扇出这一族模块再收一次：预算类的数字常量只许长在 SSOT 里。
    const fanoutModules = files.filter(
      (file) => file.rel !== SSOT && /fanout/iu.test(file.rel)
    )
    expect(fanoutModules.length, '一个扇出模块都没扫到——判据失效').toBeGreaterThanOrEqual(3)

    const declared = fanoutModules.flatMap((file) =>
      [...file.source.matchAll(/^(?:export )?const (\w+)\s*(?::\s*number\s*)?=\s*\d+$/gmu)].map(
        (match) => `${file.rel}: ${match[1]}`
      )
    )
    expect(declared, [
      '扇出模块里出现了自己声明的数字预算。这一族的上限、并发数之类的数字只许长在',
      'src/shared/fanout-limits.ts —— 否则同一个概念又会有两个名字，而 tsc 认不出它们该相等。'
    ].join('\n')).toEqual([])
  })
})
