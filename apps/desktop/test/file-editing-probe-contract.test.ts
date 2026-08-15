import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// 打包验收与被验收的探针之间，有两个**必须逐字相等**的串，各自在构建图两侧手抄。
//
// 一、报告 schema `agentmux.workspace-file-editing-e2e.v2`
//   写入方：`src/main/file-editing-probe.ts` 的两个 publishReport（成功/失败各一次）。
//   验收方：`scripts/package-macos.mjs` 的 `fileEditing.schema === '…'`。
//   把生产侧 bump 到 `.v3`，验收侧仍在比 `.v2`——`package:mac` 在挂载盘那一步失败，而失败发生在
//   整个签名、公证、挂载流程之后，是这条流水线上最贵的位置。
//
// 二、主 Workspace id `workspace-file-editing-e2e`
//   写入方：`scripts/file-editing-fixture.mjs` 的 `FILE_EDITING_PRIMARY_WORKSPACE_ID`。
//   读取方：`src/main/file-editing-probe.ts` 三处筛选、`src/main/index.ts` 一处 find。
//   `index.ts:300` 那段注释已经写着「These two ids must match the ones …fixture.mjs writes」——
//   也就是说这件事团队早就知道是手抄的，只是没有任何东西在守它。
//
// 为什么不抽共享常量：写入/验收方各有一侧是 `scripts/*.mjs`，导不了 `src/` 里的 TS 常量，tsc 也
// 看不见 `.mjs`。本仓的「构建图之外的手抄常量」就是这一类，`bundle-id-user-data.test.ts` 为
// bundle id 建立的收口手段是同一个：按**谁写那个串**逐侧解析出实际值，再要求它们相等。
//
// 为什么不像某些建议那样「让验收侧从报告自己声明的版本里取」：那会把断言变成恒真。验收侧存在的
// 意义正是**它独立地知道该收到哪个版本**；拿被验收对象的自述当期望值，等于让被测方自己出卷子
// （本仓记过 weak-assertion-patterns 的第一条：期望值由被测对象算出）。
//
// 解析失配必须响亮失败，不能静默变成 null === null——每组都先有一条自检。

const DESKTOP = new URL('../', import.meta.url)

function read(relative: string): string {
  return readFileSync(new URL(relative, DESKTOP), 'utf8')
}

/** 探针写进报告的 schema 串。取 publishReport 的 `schema:` 属性，所有出现都取。 */
function emittedSchemas(): string[] {
  return [...read('src/main/file-editing-probe.ts').matchAll(/schema: '([^']+)'/g)].map(
    (match) => match[1]!
  )
}

/** 打包脚本断言它**应当**收到的那个 schema 串。 */
function acceptedSchema(): string | null {
  const match = /fileEditing\.schema === '([^']+)'/.exec(read('scripts/package-macos.mjs'))
  return match ? match[1]! : null
}

/** fixture 写进 config 的两个 Workspace id，取常量声明本身。主与备各一个。 */
function fixtureWorkspaceIds(): string[] {
  return [
    ...read('scripts/file-editing-fixture.mjs').matchAll(
      /^export const FILE_EDITING_(?:PRIMARY|ALTERNATE)_WORKSPACE_ID = '([^']+)'/gm
    )
  ].map((match) => match[1]!)
}

/** 主进程与探针里手抄那两个 id 的每一处。 */
function consumedWorkspaceIds(): { path: string; value: string }[] {
  return ['src/main/file-editing-probe.ts', 'src/main/index.ts'].flatMap((path) =>
    [...read(path).matchAll(/'(workspace-file-editing-[a-z0-9-]+)'/g)].map((match) => ({
      path,
      value: match[1]!
    }))
  )
}

describe('打包验收与探针共用的两个串', () => {
  it('四个解析点各自都取得出值——正则失配要红，不能让下面的相等断言退化成恒真', () => {
    // 自检。这四个函数都是文本解析，重构掉它们锚定的形状（换引号、抽成变量、改成模板串）会让
    // 匹配落空；不在这里响亮失败的话，`undefined === undefined` 会替坏世界背书。
    expect(emittedSchemas(), 'file-editing-probe.ts 的 schema 写入没解析出来').not.toHaveLength(0)
    expect(acceptedSchema(), 'package-macos.mjs 的 schema 断言没解析出来').not.toBeNull()
    expect(fixtureWorkspaceIds(), 'file-editing-fixture.mjs 的 Workspace id 常量没解析出来').toHaveLength(2)
    expect(consumedWorkspaceIds(), '主进程侧一处 workspace id 都没解析出来').not.toHaveLength(0)
  })

  it('探针写的 schema 与打包断言的 schema 逐字相等', () => {
    // 这一对分岔的代价是最贵的那种：`package:mac` 走完签名、公证、挂载，最后一步才拒绝。
    for (const emitted of emittedSchemas()) {
      expect(
        emitted,
        `探针写 ${emitted}，打包脚本却在等 ${acceptedSchema()}——package:mac 会在挂载验收那一步失败`
      ).toBe(acceptedSchema())
    }
  })

  it('探针的成功与失败两条路写同一个 schema', () => {
    // 两个 publishReport 分别在 try 与 catch 里。只改一个的后果是失败报告带着旧版本号，
    // 而打包脚本先比 `ok === true` 再比 schema，于是这个分岔在成功路径上永远不显形。
    expect(new Set(emittedSchemas()).size, `探针的两条路写了不同的 schema：${emittedSchemas().join(' / ')}`).toBe(1)
  })

  it('主进程侧手抄的每一个 Workspace id 都是 fixture 真写进 config 的那两个之一', () => {
    // 分岔的症状不是报错：探针按一个不存在的 id 去筛，得到空集合，于是它断言的那些交互「没发生」。
    // 那是一条指向错误方向的失败——看起来像文件编辑坏了，真因是两边在说两个 Workspace。
    //
    // 判据是「属于 fixture 那两个之中」而不是「等于主那一个」：`index.ts` 刻意同时读主与备
    // （:297-298，两个都缺就抛），把它们压成一个会让这条在正确的世界里就红。反过来这条仍然抓得住
    // 真正的分岔——任何一侧改了串，那一侧就不再落在另一侧的集合里。
    for (const { path, value } of consumedWorkspaceIds()) {
      expect(
        fixtureWorkspaceIds(),
        `${path} 手抄的 ${value} 不在 fixture 写入的 id 里——探针会去筛一个不存在的 Workspace`
      ).toContain(value)
    }
  })

  it('fixture 声明的两个 id 都真的有人读——没人读的那个是一条死约定', () => {
    // 反向的一半。上面那条只问「读的人有没有读错」，它对「fixture 声明了一个从来没人读的 id」
    // 完全失明，而那正是这类常量对最容易烂掉的方式：删掉消费点、留下声明，看起来两边还对着。
    const consumed = new Set(consumedWorkspaceIds().map((entry) => entry.value))
    for (const declared of fixtureWorkspaceIds()) {
      expect(
        [...consumed],
        `fixture 声明了 ${declared}，但主进程侧没有任何一处读它`
      ).toContain(declared)
    }
  })
})
