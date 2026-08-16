import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  composerCompositionHandlers,
  composerRenderValue,
  nextComposerCompositionState,
  type ComposerCompositionState
} from '../src/renderer/src/lib/composer-composition.js'

/**
 * #609「给 Agent 输入中文, 删掉后再输入, 会变成不是我输入的奇怪的文字」。
 *
 * ─── 这一族**不能**用行为测试守到底，必须明说 ───
 *
 * 本文件验证 textarea 状态机和静态接线。desktop 已有 happy-dom，可派发合成 composition 事件，
 * 但它不能代替真实操作系统的中文输入法；不要把这些断言读成真实 IME 端到端验证。
 *
 * 于是判据分三层，各自能独立变红（本仓记过「抽进 lib 只解决一半」「守卫要判可达性不是在场」）：
 *
 *   行为层 —— 状态机、渲染取值、四个处理器的副作用。可直接调用并断言。
 *   接线层 —— AST：`ComposerTextarea` 那个 textarea 上四个属性真的在场、每个的值就是对应那次转发，
 *             `value` 真的经过 `composerRenderValue`。这一层抓「lib 写对了但壳没接 / 接错了一个」。
 *   消费层 —— AST：普通 textarea 使用 `ComposerTextarea`；AgentComposer 已接入 InlineComposer，
 *             其组字、选择与撤销由 ProseMirror 负责。两种编辑面都必须接真实取值与草稿写回口。
 *
 * 接线层与消费层**不**保证：组件会被挂载、React 真的会把这些属性接成 DOM 监听器、Chromium 真的按这个
 * 顺序派发 composition 事件。那三件事要真 DOM 环境。别把这族测试读成「IME 已验证正常」。
 */

const SHELL = resolve(__dirname, '../src/renderer/src/components/ComposerTextarea.tsx')
const CONSUMER = resolve(__dirname, '../src/renderer/src/components/AgentComposer.tsx')

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** 某个文件里，某个标签名的开标签上：属性名 → 属性值的源码文本（归一化空白）。 */
function attributesOfTag(path: string, tagName: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const walk = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === tagName
    ) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue
        const initializer = attribute.initializer
        const text =
          initializer && ts.isJsxExpression(initializer)
            ? (initializer.expression?.getText() ?? '')
            : (initializer?.getText() ?? '')
        attributes.set(attribute.name.getText(), text.replace(/\s+/g, ' ').trim())
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(parse(path))
  return attributes
}

/** 某个文件里出现过的全部 JSX 标签名。 */
function tagNamesIn(path: string): string[] {
  const names: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      names.push(node.tagName.getText())
    }
    ts.forEachChild(node, walk)
  }
  walk(parse(path))
  return names
}

// ---------------------------------------------------------------------------
// 行为层 A：状态机。四条规则各自承重——每条都对应一类破坏重新可达。
// ---------------------------------------------------------------------------
describe('nextComposerCompositionState', () => {
  it('compositionstart 进入组字并记下 DOM 里那份', () => {
    expect(nextComposerCompositionState(null, { kind: 'start', domValue: '中' })).toEqual({ domValue: '中' })
  })

  it('compositionupdate 刷新镜像', () => {
    expect(
      nextComposerCompositionState({ domValue: '中' }, { kind: 'update', domValue: '中文' })
    ).toEqual({ domValue: '中文' })
  })

  it('没在组字时收到 update 也进入组字——两种处置的代价不对称，取保守那侧', () => {
    // 这条是刻意选择，不是顺手：忽略它的代价是数据被改坏（正是本缺陷），进入组字的代价只是
    // 「这次外部写入被压到下一次非组字 input 或 end」，而那两条都会立刻清掉状态。
    expect(nextComposerCompositionState(null, { kind: 'update', domValue: '文' })).toEqual({ domValue: '文' })
  })

  it('compositionend 退出组字', () => {
    expect(nextComposerCompositionState({ domValue: '中文' }, { kind: 'end', domValue: '中文' })).toBeNull()
  })

  it('input 只刷新已有的组字镜像，绝不开启组字', () => {
    // 两侧都钉：开启侧被禁（否则普通英文输入会永久走镜像分支，store 与 DOM 从此分家），
    // 刷新侧必须在（否则组字中的每次 input 都让镜像落后 DOM 一步，React 又有得写了）。
    expect(nextComposerCompositionState(null, { kind: 'input', domValue: 'abc' })).toBeNull()
    expect(
      nextComposerCompositionState({ domValue: '中' }, { kind: 'input', domValue: '中文' })
    ).toEqual({ domValue: '中文' })
  })
})

// ---------------------------------------------------------------------------
// 行为层 B：这一帧交出去的取值。整条修复的判决点。
// ---------------------------------------------------------------------------
describe('composerRenderValue', () => {
  it('没在组字就给外部取值（普通受控）', () => {
    expect(composerRenderValue('draft', null)).toBe('draft')
  })

  it('组字期间给镜像，即使外部取值已经不同——React 那句无条件赋值因此不成立', () => {
    // 判据落在「两者不同」这个前提上：`external` 与镜像相等时，恒返回 external 的变异也会通过。
    expect(composerRenderValue('外部改过的内容', { domValue: '组字中的预览' })).toBe('组字中的预览')
  })
})

// ---------------------------------------------------------------------------
// 行为层 C：四个处理器的副作用。判据按「状态被写成什么」+「外界被碰了几次」，不钉某个具体 spy。
// ---------------------------------------------------------------------------
describe('composerCompositionHandlers', () => {
  function harness(state: ComposerCompositionState) {
    const states: ComposerCompositionState[] = []
    const written: string[] = []
    return {
      states,
      written,
      handlers: composerCompositionHandlers({
        state,
        setState: (next) => states.push(next),
        writeValue: (value) => written.push(value)
      })
    }
  }

  it('change 在没有组字时清状态并把取值交给上游', () => {
    const h = harness(null)
    h.handlers.change('abc')
    expect(h.states).toEqual([null])
    expect(h.written).toEqual(['abc'])
  })

  it('change 在组字中刷新镜像，并且照旧写上游（Send 的 canSubmit / Enter 闸读它）', () => {
    const h = harness({ domValue: '中' })
    h.handlers.change('中文')
    expect(h.states).toEqual([{ domValue: '中文' }])
    expect(h.written).toEqual(['中文'])
  })

  it('compositionStart / compositionUpdate 只动状态，不碰上游', () => {
    // 「碰了外界几次」是判据：这两个处理器里多写一次 writeValue 会让组字中间态漏进草稿表，
    // 而那正是缺陷的一半来路。
    const start = harness(null)
    start.handlers.compositionStart('中')
    expect(start.states).toEqual([{ domValue: '中' }])
    expect(start.written).toEqual([])

    const update = harness({ domValue: '中' })
    update.handlers.compositionUpdate('中文')
    expect(update.states).toEqual([{ domValue: '中文' }])
    expect(update.written).toEqual([])
  })

  it('compositionEnd 同时清状态并推最终文本——两件事都要，且顺序是先清后写', () => {
    // 少写 writeValue：清掉镜像那一帧渲染的是**旧的**外部取值，React 立刻把 DOM 改回去，
    // 用户刚上屏的字当场消失。少 setState：此后永久走镜像分支，输入框变只读。
    const h = harness({ domValue: '中文' })
    h.handlers.compositionEnd('中文了')
    expect(h.states).toEqual([null])
    expect(h.written).toEqual(['中文了'])
  })
})

// ---------------------------------------------------------------------------
// 接线层：壳。这些断言在「lib 对了但 textarea 没接上/接错一个」时红——那时行为层全绿而缺陷在。
// ---------------------------------------------------------------------------
describe('ComposerTextarea 真的把组字接到了这一层', () => {
  it('value 经过 composerRenderValue，且喂的就是那两个取值', () => {
    // 守的缺陷形状：`value={value}`（回到修复之前）——那时状态机全对而 React 照旧无条件赋值。
    // 判据不只问「函数名在场」，还钉住两个实参：漏掉 composition 那个会让镜像永不生效。
    const attributes = attributesOfTag(SHELL, 'textarea')
    expect(attributes.size, '提取器没找到 textarea 的属性——提取器写错了或标签被换掉').toBeGreaterThan(0)
    expect(attributes.get('value')).toBe('composerRenderValue(value, composition)')
  })

  it('四个组字/输入属性各自在场，且每个的值就是对应那次转发', () => {
    // 一次只错一个的形状：漏 onCompositionEnd → 输入框永久只读；漏 onCompositionStart → 镜像永不
    // 建立，缺陷原样；把 onChange 接成 compositionUpdate → 普通英文输入也进组字分支。逐条比对
    // 而不是「四个名字都出现过」，正是为了让这三种各自变红。
    const attributes = attributesOfTag(SHELL, 'textarea')
    expect(attributes.get('onChange')).toBe('(event) => ime.change(event.target.value)')
    expect(attributes.get('onCompositionStart')).toBe(
      '(event) => ime.compositionStart(event.currentTarget.value)'
    )
    expect(attributes.get('onCompositionUpdate')).toBe(
      '(event) => ime.compositionUpdate(event.currentTarget.value)'
    )
    expect(attributes.get('onCompositionEnd')).toBe(
      '(event) => ime.compositionEnd(event.currentTarget.value)'
    )
  })

  it('壳里那份 ime 就是 composerCompositionHandlers 的结果，且 writeValue 接的是调用方的回调', () => {
    // 守的形状：处理器工厂被调用了但 writeValue 接到别处（比如一个本地 setState），那时草稿表
    // 永远收不到用户打的字，而上面每一条断言照旧全绿。
    const source = readFileSync(SHELL, 'utf8')
    expect(source).toMatch(/const ime = composerCompositionHandlers\(\{/)
    expect(source).toMatch(/writeValue: onValueChange/)
    // 状态那一份必须是组件自己的 useState：接成常量 null 会让镜像永不生效（缺陷原样回来）。
    expect(source).toMatch(/useState<ComposerCompositionState>\(null\)/)
    expect(source).toMatch(/state: composition/)
    expect(source).toMatch(/setState: setComposition/)
  })

  it('壳里没有第二处组字判定：composition 的取值只被 composerRenderValue 与那次注入读到', () => {
    // 本仓「读的 key 与写的 key 必须只判一次」那族：壳里再写一个 `composition ? … : …` 就是第二处
    // 无人守的判定。判据是这个标识符在文件里的出现处恰好是它该出现的那几处。
    const source = parse(SHELL)
    const uses: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'composition') {
        const parent = node.parent
        // 声明本身（`const [composition, setComposition] = …`）不算一次「读」。
        if (!ts.isBindingElement(parent) && !ts.isArrayBindingPattern(parent)) {
          uses.push(parent.getText().replace(/\s+/g, ' ').trim())
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    expect(uses.length, 'composition 一次都没被读到——提取器写错了或接线被删').toBeGreaterThan(0)
    expect(uses.sort()).toEqual(['composerRenderValue(value, composition)', 'state: composition'])
  })

  it('壳把其余属性整份转发下去，所以调用方的 onKeyDown/placeholder 不会被静默吞掉', () => {
    // 守的形状：漏掉 `{...rest}` 时 Enter 提交、placeholder、disabled 全部静默失效，而组字照样对。
    // 这是这层壳自己引入的新风险（多一层就多一次「传下去了吗」），所以它自己带一条判据。
    const attributes = attributesOfTag(SHELL, 'textarea')
    expect(attributes.size).toBeGreaterThan(0)
    const source = parse(SHELL)
    let spreadsRest = false
    const walk = (node: ts.Node): void => {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText() === 'textarea'
      ) {
        spreadsRest = node.attributes.properties.some(
          (property) => ts.isJsxSpreadAttribute(property) && property.expression.getText() === 'rest'
        )
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    expect(spreadsRest, 'textarea 没有 {...rest}：调用方给的 onKeyDown / placeholder 会被静默丢掉').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 消费层：**每一个**受控 textarea 都用了这层壳。壳做对了但某一格没用它，前两层全绿而用户的
// 缺陷在那一格完好无损。
//
// ─── 判据为什么必须全树扫，而不是点名一个消费者（#622）───
//
// 这一段此前只钉 `AgentComposer` 一个文件。而缺陷从来不是「AgentComposer 忘了处理组字」——
// ComposerTextarea 的 docstring 自己写明那是**每一个**受控 textarea 的默认状态（本仓实测 8 个，
// #609 之前 0 个认识组字）。于是点名一个消费者时，另外 7 个（启动器 prompt、PR 描述、讨论主题、
// commit message、浏览器标注、Agent 设置的 args/env）照旧带着缺陷，而这个文件每一条判据全绿——
// 本仓「抽进 lib 只解决一半」那一族，在组件层的同一课。
//
// 改法：扫整棵 renderer 源码树，禁止 `<textarea>` 出现在壳以外的任何文件里。判据落在 **JSX 标签名**
// 而不是文本 `'<textarea'`：注释里提到裸 textarea 的地方有好几处（本仓有「注释里描述规则的文字不是
// 规则本身」那族先例），走 TS parser 就不会误伤它们。
//
// 例外恰好一个——壳自己，它内部当然要渲染真的 textarea。例外自带前提自检：壳里必须真的有一个
// textarea，否则「例外」会在壳被改坏时替它背书。
// ---------------------------------------------------------------------------
const RENDERER_SRC = resolve(__dirname, '../src/renderer/src')
/** 唯一允许出现裸 `<textarea>` 的文件（相对 RENDERER_SRC）。 */
const SOLE_RAW_TEXTAREA = 'components/ComposerTextarea.tsx'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/u.test(entry.name)) out.push(path)
  }
  return out
}

describe('每个受控 textarea 都走认识组字的那层壳', () => {
  it('整棵 renderer 源码树里只有壳自己渲染裸 textarea', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER_SRC)) {
      const relative = file.slice(RENDERER_SRC.length + 1)
      if (relative === SOLE_RAW_TEXTAREA) continue
      if (tagNamesIn(file).includes('textarea')) offenders.push(relative)
    }
    // 报出文件名而不是只给个数：漂移点要一眼看得到。
    expect(
      offenders,
      '这些文件写了裸 <textarea>，那一格绕开了组字和解层，中文输入删掉再输入会变成不是用户输入的字' +
        `（#609）。改成 <ComposerTextarea value onValueChange>：\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('自检：扫描面覆盖到了壳与已知消费者，且那条例外真的有前提', () => {
    // 防这条自己假绿的三种方式：
    //   1. 扫描根/后缀过滤写错 ⇒ 文件集合为空，offenders 恒为空数组，「没扫到」与「扫过了没问题」
    //      打印出来一模一样（本仓「扫描根写错静默变绿」那族）；
    //   2. 提取器认不出 JSX 标签 ⇒ 同上恒真。所以要在**已知有 textarea 的那个文件**上正向验证；
    //   3. 那条例外变成为坏修复背书 ⇒ 壳里的 textarea 被换掉/删掉时，例外让它照旧免检。
    const files = sourceFiles(RENDERER_SRC).map((file) => file.slice(RENDERER_SRC.length + 1))
    expect(files).toContain(SOLE_RAW_TEXTAREA)
    expect(
      tagNamesIn(`${RENDERER_SRC}/${SOLE_RAW_TEXTAREA}`),
      '壳里没有 textarea：那条例外正在为一个已经坏掉的壳背书'
    ).toContain('textarea')

    // 消费者侧的在场证明：至少要有若干文件在用这层壳。写成 `toBeGreaterThan(0)` 不够——那在
    // 「只剩某一个消费者、其余格被改回裸 textarea」时也成立，而上面那条会把它们逮到；
    // 这里要的是「这层壳真的被广泛用着」，所以地板取自实测值。改动接线时这个数要跟着改，且改的
    // 时候必须说明为什么某一格不再需要壳。AgentComposer 改用 ProseMirror 后，Session 与 Launcher 都改用 ProseMirror 后，实际仍有 6 个
    // 消费文件（包括 Gallery 的普通文本示例），所以保留这个地板。
    const consumers = files.filter(
      (file) => file !== SOLE_RAW_TEXTAREA && tagNamesIn(`${RENDERER_SRC}/${file}`).includes('ComposerTextarea')
    )
    expect(
      consumers.length,
      `用壳的文件只剩 ${consumers.length} 个（${consumers.join(', ')}），少于实测的 6 个：` +
        '要么某一格被删掉了，要么它绕回了别的写法（若是裸 textarea 则上面那条也会红）'
    ).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// 消费层补充：AgentComposer 那一格喂进 InlineComposer 的是什么。标签名在场之外还要钉实参——接成 `value={''}`
// 或 `onValueChange={() => {}}` 时标签判据全绿，而那一格分别变成永久空、或者永远存不下草稿。
// InlineComposer 使用 ProseMirror 的组字生命周期，不再套 textarea 的 React value 镜像。
// ---------------------------------------------------------------------------
describe('AgentComposer 接入 InlineComposer 的受控取值与草稿写回口', () => {
  it('新编辑面仍收到真实取值与写回回调', () => {
    const attributes = attributesOfTag(CONSUMER, 'InlineComposer')
    expect(attributes.size).toBeGreaterThan(0)
    expect(attributes.get('value')).toBe('value')
    expect(attributes.get('onValueChange')).toBe('onChange')
  })
})
