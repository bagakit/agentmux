import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildPromptInputPayload,
  sanitizeBracketedPasteText,
  wrapBracketedPasteText
} from '../src/bracketed-paste.js'

// 这四个导出此前全仓零测试（`grep -rn` 在 packages/core/test 与 apps/desktop/test 下 0 命中），
// 而它们是「一段文本要进 PTY 时 ESC 怎么办」的唯一判定，两个进程都靠它。
//
// 本文件里的控制字符一律用 `String.fromCharCode` 构造，不写字面转义也不敲裸字节：裸 0x1b 在 diff /
// grep / 审阅里都不可见（tracker #385 就是一个 NUL 字节让整个测试文件对 `git grep` 永久失明）。
const ESC = String.fromCharCode(0x1b)
const VISIBLE_ESC = String.fromCharCode(0x241b)

describe('sanitizeBracketedPasteText：按字节挡 ESC', () => {
  it('把 ESC 换成可见的 ␛ 而不是删掉（用户要看得见自己粘了什么）', () => {
    expect(sanitizeBracketedPasteText(`a${ESC}b`)).toBe(`a${VISIBLE_ESC}b`)
  })

  it('替换而非删除：长度不变，故不会把相邻字节挤到一起改变语义', () => {
    const input = `${ESC}${ESC}x`
    expect(sanitizeBracketedPasteText(input)).toHaveLength(input.length)
  })

  it('每一个 ESC 都换掉，不是只换第一个（replaceAll 而非 replace）', () => {
    // 这条钉住的正是「漏掉后续 ESC」这一种改法：只换第一个时，第二段序列原样到达 PTY。
    expect(sanitizeBracketedPasteText(`${ESC}[31m red ${ESC}[0m`)).toBe(
      `${VISIBLE_ESC}[31m red ${VISIBLE_ESC}[0m`
    )
  })

  it('不含 ESC 的文本原样通过（消毒器不许顺手改别的字节）', () => {
    const plain = 'echo hello\nls -la\t# 中文与 emoji 🙂'
    expect(sanitizeBracketedPasteText(plain)).toBe(plain)
  })

  it('判据是「ESC 这个字节」而不是「结束符那个串」：伪造的开始符同样被拆掉', () => {
    // 只挡 `ESC[201~` 的实现会放行这一条，于是载荷能伪造一个 bracket 开始。
    expect(sanitizeBracketedPasteText(`${ESC}[200~`)).toBe(`${VISIBLE_ESC}[200~`)
  })
})

describe('wrapBracketedPasteText：包装不等于转义', () => {
  it('先消毒后包装——顺序反了会把我们自己的包装符也消掉', () => {
    const wrapped = wrapBracketedPasteText('plain')
    expect(wrapped.startsWith(BRACKETED_PASTE_START), '开始符被消毒器吃掉了').toBe(true)
    expect(wrapped.endsWith(BRACKETED_PASTE_END), '结束符被消毒器吃掉了').toBe(true)
  })

  it('载荷自带的结束符不能提前闭合括号（这是本模块存在的理由）', () => {
    // 上游 xterm 5.5.0 只包不转义，于是 `ESC[201~` 之后的字节重新被 shell 当命令读。
    const wrapped = wrapBracketedPasteText(`${ESC}[201~; rm -rf /`)
    expect(
      wrapped.indexOf(BRACKETED_PASTE_END),
      '结束符第一次出现的位置不在末尾——载荷提前闭合了 bracket'
    ).toBe(wrapped.length - BRACKETED_PASTE_END.length)
  })

  it('包装后的正文里除两端的包装符外不含任何裸 ESC', () => {
    const body = wrapBracketedPasteText(`${ESC}[201~x${ESC}[200~y`).slice(
      BRACKETED_PASTE_START.length,
      -BRACKETED_PASTE_END.length
    )
    expect(body.includes(ESC), '正文里漏了裸 ESC').toBe(false)
  })
})

describe('buildPromptInputPayload：两条分支都消毒（本函数的不变量）', () => {
  it('单行不包 bracket——对端没开 bracketed paste 时那两个序列会原样显示出来', () => {
    expect(buildPromptInputPayload('one line')).toBe('one line')
  })

  it('多行才包 bracket（避免中途被当成回车提交）', () => {
    expect(buildPromptInputPayload('a\nb')).toBe(wrapBracketedPasteText('a\nb'))
  })

  it('\\r 与 \\n 都算多行', () => {
    expect(buildPromptInputPayload('a\rb').startsWith(BRACKETED_PASTE_START)).toBe(true)
    expect(buildPromptInputPayload('a\nb').startsWith(BRACKETED_PASTE_START)).toBe(true)
  })

  it('单行分支同样消毒——不变量是「无论走哪条分支，ESC 都不以原字节到达 PTY」', () => {
    // 这条独立于多行那条：把单行分支从 sanitize 改成直接返回 prompt，只有它会红。
    const single = buildPromptInputPayload(`${ESC}[31m`)
    expect(single.includes(ESC), '单行分支漏了消毒').toBe(false)
    expect(single).toBe(`${VISIBLE_ESC}[31m`)
  })

  it('多行分支同样消毒（判据落在正文上——两端的包装符按定义就是 ESC 开头的）', () => {
    const body = buildPromptInputPayload(`${ESC}[201~\nx`).slice(
      BRACKETED_PASTE_START.length,
      -BRACKETED_PASTE_END.length
    )
    expect(body.includes(ESC), '多行分支漏了消毒').toBe(false)
  })
})

/**
 * node-free 是这个模块能被渲染进程消费的**前提**，不是一句注释里的愿望：`providers/shared.ts` 顶上
 * 就是 `import { existsSync } from 'node:fs'`，根 barrel 也会把 Core 的运行时拖进来，所以判定一旦
 * 回流到那些文件，渲染层唯一的出路就是再手抄一份。
 *
 * 判据是 **import 关系**而不是「文件里有没有出现 `node:` 这几个字」——本文件头部的注释里就写着
 * `node:fs`，文本判据会被自己的注释假红，也会被 `import ("node:" + "fs")` 这类拼法假绿。
 */
describe('bracketed-paste.ts 不 import 任何 node: 内置模块（渲染进程可消费的前提）', () => {
  const leafPath = fileURLToPath(new URL('../src/bracketed-paste.ts', import.meta.url))

  function parse(name: string, source: string): ts.SourceFile {
    return ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  }

  /** 模块里所有静态 import 的模块路径（含 type-only：type-only 不进运行时，但列出来便于诊断）。 */
  function importedSpecifiers(sourceFile: ts.SourceFile): string[] {
    return sourceFile.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : []
    )
  }

  const leafAst = parse('bracketed-paste.ts', readFileSync(leafPath, 'utf8'))

  it('一条 node: import 都没有', () => {
    expect(
      importedSpecifiers(leafAst).filter((specifier) => specifier.startsWith('node:')),
      'bracketed-paste.ts 开始 import node: 内置模块了——渲染进程从此够不着它，' +
        '终端粘贴路径会被迫再手抄一份消毒器'
    ).toEqual([])
  })

  it('干脆一条 import 都没有（叶子模块，无传递依赖可把 node: 带进来）', () => {
    // 上一条只挡直接依赖：`import './x.js'` 而 x.js 自己 import node:fs 一样会污染渲染进程。
    // 这个模块今天没有任何依赖，把这件事钉死比追传递闭包便宜且更严。
    expect(importedSpecifiers(leafAst), 'bracketed-paste.ts 有了依赖——请顺着它确认传递闭包仍是 node-free').toEqual([])
  })

  it('自检：判据认得出它要抓的形状，也不被注释里的 node: 字样骗到', () => {
    const offending = parse('probe.ts', "import { existsSync } from 'node:fs'\nexport const x = 1")
    expect(importedSpecifiers(offending), '认不出真的 node: import').toEqual(['node:fs'])

    const commentOnly = parse(
      'probe.ts',
      "// 这里提到 node:fs 只是解释为什么不能 import 它\nexport const x = 1"
    )
    expect(importedSpecifiers(commentOnly), '把注释里的 node:fs 当成了 import——文本判据的老毛病').toEqual([])
  })
})
