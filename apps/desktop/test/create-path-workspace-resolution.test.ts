const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

// ---------------------------------------------------------------------------
// 「建在 A、却按当前 Workspace 去打开」这一类。#269 修的是 createNote 那条，这里守的是
// 同一形状在**组件**里的实例（文件树里新建文件）。
//
// 根因不是「忘了传参」，而是**同一件事被解析了两次**：createPath 自己读一次
// activeWorkspaceId，openFile 再读一次。两次之间只要有一个 await（本地建文件也有 IPC，
// 远端可达 15s），用户点一下侧栏就漂移。症状不是报错而是**开错文件**——index.ts /
// README.md 这类名字在两个项目里都有时，界面上一切正常。
//
// 修法是让 createPath 返回它实际用的那个 id，下游拿着走，于是全程只解析一次。
// ---------------------------------------------------------------------------
// The former in-memory files.create cases now execute the real Source gateway,
// Native file and Store consumer in file-path-client-projection.test.ts:
// "Source file creation returns its captured display Workspace across a late active Workspace switch".
// Both original assertions (returned Workspace and opened document ownership) remain there.

// ---------------------------------------------------------------------------
// 上面两条守的是 store 一侧算得对。但组件那一侧「有没有把返回值接上」照旧无人守——
// 见记忆 extracting-to-lib-only-fixes-half：内容可测了，壳有没有执行到是另一件事。
// 这里判源码里那次调用的形状，而不是判某个标识符出现过。
// ---------------------------------------------------------------------------
describe('文件树新建文件把建出来的 Workspace 交给 openFile', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/FileExplorer.tsx', import.meta.url),
    'utf8'
  )

  it('前提自检：commitEdit 里确实有那对 create→open 调用，判据没有挂在空处', () => {
    // 文件被重构（函数改名、这段搬走）时这条先红，届时下面那条的失败位置才不会误导人。
    expect(source).toMatch(/async function commitEdit\(/)
    expect(source).toMatch(/createPath\(\{/)
  })

  /**
   * `const <名字> = await createPath({` 里的那个名字。判据必须落在**这个**标识符上，
   * 而不是「第四个参数位置有个词」——对抗 review 实测 `\w+` 会把 `undefined` 这个词
   * 和一个「await 之后重新读活动 Workspace」的新变量一起放过去，两者都是原缺陷本身。
   */
  const createdBinding = source.match(/const\s+(\w+)\s*=\s*await\s+createPath\(/)?.[1]

  it('createPath 的返回值被绑到了一个名字上——不接返回值就没有东西可往下传', () => {
    // 这条先于下面那条：若没人接返回值，下面那条的失败会读作「参数写错了」，
    // 而真相是「上游的返回值被丢了」。
    expect(createdBinding, 'commitEdit 没有把 createPath 的返回值接下来').toBeDefined()
  })

  it('openFile 收到的正是那个绑定，而不是让它自己再解析一次', () => {
    // 判据落在「第四个参数**就是** createPath 的返回值」上：openFile(path) 与
    // openFile(path, u, u, 任何东西) 在 tsc 眼里都合法（后三个都是可选参数），
    // 所以类型系统守不住这个——见记忆 tsc-guards-literal-inversion-only。
    expect(source).toMatch(
      new RegExp(String.raw`openFile\(\s*path\s*,\s*undefined\s*,\s*undefined\s*,\s*${createdBinding}\s*\)`)
    )
    // 反向：不许存在「新建后裸调 openFile(path)」这种写法。
    expect(source).not.toMatch(/openFile\(\s*path\s*\)/)
    // 反向二：那个位置也不许出现任何「自己再解析一次」的取值。名字对了但**值**是重新读来的，
    // 症状与原缺陷一字不差（实测这种变异能通过只判标识符形状的判据）。
    // 判的是 commitEdit 那一段里有没有第二次解析，而不是整个文件——文件别处读活动 Workspace
    // 是正常的。
    const commitEditBody = source.slice(
      source.indexOf('async function commitEdit('),
      source.indexOf('async function confirmDelete(')
    )
    expect(commitEditBody.length).toBeGreaterThan(0)
    expect(
      commitEditBody,
      'commitEdit 在建完文件之后又读了一次活动 Workspace——那就是两次解析'
    ).not.toMatch(/activeWorkspaceId/)
  })
})
