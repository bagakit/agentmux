import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 一个受控表单控件失去写回口，就永久变成只读——而整个测试套件不会红。
//
// 实测（#120）：把 NewTabSurface 两个名字输入的 `onChange` 删掉，两格输入框永久不可写
// （agentName/tabName 恒为空串，交给 launchAgent 的载荷恒是 `{undefined, undefined}`，用户填什么
// 都没用），launch-naming 5 条 + 所有涉及 NewTabSurface 的 23 条**全绿**，`tsc --noEmit` 也干净。
// 本仓的渲染只有 renderToStaticMarkup：它不跑 useEffect、不派发 DOM 事件，所以"输入框收得到键盘
// 输入吗"这件事没有任何行为测试能覆盖到——只能守形状。
//
// 判据不是我自己发明的清单，而是 **React 运行时自己的规则**：给了 `value`/`checked` 却既没有
// `onChange` 也没有 `readOnly`/`disabled`，React 会 console.error 一句
// "You provided a `value` prop to a form field without an `onChange` handler"。受控 value 与写回口
// **按定义成对**——单独一个 value 没有任何用途（用户敲不进去），正是 `data-x={cond ? '' : undefined}`
// 那条论证的同一形状（见 rendered-class-has-rule.test.ts 的 BEM 与在场标志判据）。于是**不需要
// 例外清单**：`defaultValue`（非受控）、`readOnly`、`disabled` 都是显式声明"这里不接受输入"，
// 它们本身就是判据的一部分，而不是被豁免掉的特例。
//
// 两条腿：
//   1. 静态成对扫描，覆盖每一个组件文件——不止某条测试恰好渲染到的那几个。
//   2. 把 React 的那句告警接成断言，钉住第 1 条的判据真的就是 React 的规则（判据被悄悄放宽时，
//      这条自证会红）。
// ---------------------------------------------------------------------------

const COMPONENTS_DIR = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const COMMENTS = /\/\*[\s\S]*?\*\//g

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...tsxFiles(path))
    else if (entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

/** 受控表单元素：React 认这三个标签的 value/checked 为受控。 */
const CONTROLLED_TAGS = ['input', 'textarea', 'select']

type Control = { file: string; tag: string; props: string; line: number }

/**
 * 取出每一个 `<input|textarea|select ...>` 开标签里的属性文本。
 *
 * 用平衡计数扫到开标签结束，而不是 `/<input[^>]*>/`：属性里出现 `=>`（箭头函数）或 `a > b` 时
 * `[^>]*` 会提前截断，于是 onChange 明明在那儿却被切掉——判据会把好代码报成缺写回口。
 */
function controls(source: string, file: string): Control[] {
  const out: Control[] = []
  const clean = source.replace(COMMENTS, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  for (const tag of CONTROLLED_TAGS) {
    const opener = new RegExp(`<${tag}(?=[\\s/>])`, 'g')
    for (const match of clean.matchAll(opener)) {
      let index = match.index! + match[0].length
      let depth = 0
      let quote: string | null = null
      while (index < clean.length) {
        const char = clean[index]!
        if (quote) {
          if (char === quote) quote = null
        } else if (char === '"' || char === "'" || char === '`') {
          quote = char
        } else if (char === '{') depth += 1
        else if (char === '}') depth -= 1
        else if (char === '>' && depth === 0) break
        index += 1
      }
      out.push({
        file,
        tag,
        props: clean.slice(match.index! + match[0].length, index),
        line: clean.slice(0, match.index!).split('\n').length
      })
    }
  }
  return out
}

/** 声明了受控取值（React 会因此接管这个控件的显示值）。 */
function isControlled(props: string): boolean {
  return /(^|\s)(value|checked)\s*=/.test(props)
}

/**
 * 有写回口，或显式声明了**永不**接受输入。两者都让"受控"自洽；缺了才是那个洞。
 *
 * `readOnly` / `disabled` 不是被豁免的例外，而是判据的另一半：它们显式说了这里不收输入。但只有
 * **无条件**的那种才算——`disabled={busy !== null}` 说的是"忙的时候不收"，空闲时它照旧是个要接受
 * 键盘输入的受控控件。实测这一条至关重要：事故现场那两格正好带着 `disabled={busy !== null}`，
 * 把任何 `disabled` 都算过的话，删掉 onChange 这条扫描照旧全绿（只有下面钉住现场的那条会红）。
 *
 * 展开写 `{...props}`（属性透传）也算过——写回口可能在传进来的那份里，静态读不到；这种控件另有
 * 其归属组件承担同一条判据。
 */
function hasWriteBack(props: string): boolean {
  if (/(^|\s)(onChange|onInput|\.\.\.)/.test(props)) return true
  // 无条件只读：裸 `readOnly` / `disabled`，或显式写死 `={true}`。带表达式的一概不算。
  return /(^|\s)(readOnly|disabled)(\s*=\s*\{\s*true\s*\})?(\s|$|\/)/.test(props)
}

describe('受控表单控件必须有写回口', () => {
  const all = tsxFiles(COMPONENTS_DIR).flatMap((file) =>
    controls(readFileSync(file, 'utf8'), file.slice(COMPONENTS_DIR.length + 1))
  )

  it('自检：扫到了这一批控件，且其中确实有受控的', () => {
    // 扫描根写错、正则失配都会让下面那条断言在空集上静默变绿。
    expect(all.length).toBeGreaterThan(20)
    expect(all.filter((item) => isControlled(item.props)).length).toBeGreaterThan(10)
    // 三种标签都要被这套判据覆盖到，不能只认 input。
    expect(new Set(all.map((item) => item.tag))).toEqual(new Set(CONTROLLED_TAGS))
  })

  it('自检：判据认得出缺写回口，也认得出显式只读', () => {
    expect(isControlled('value={x} onChange={f}')).toBe(true)
    expect(hasWriteBack('value={x} onChange={f}')).toBe(true)
    // 事故形状：受控但没有任何写回口。
    expect(hasWriteBack('value={x} placeholder="p"')).toBe(false)
    // 属性里带箭头函数（`=>` 里有 `>`）时仍要把整段属性读完，否则 onChange 会被切掉。
    const arrow = controls('<input value={x} onChange={(e) => setX(e.target.value)} />', 'f')[0]!
    expect(hasWriteBack(arrow.props)).toBe(true)
    // 显式声明**永不**接受输入的两种写法都算自洽。
    expect(hasWriteBack('value={x} readOnly')).toBe(true)
    expect(hasWriteBack('value={x} disabled')).toBe(true)
    expect(hasWriteBack('value={x} readOnly={true}')).toBe(true)
    // 但**有条件**的 disabled 不算：它空闲时照旧要收输入。这一条正是事故现场的形状——那两格带着
    // `disabled={busy !== null}`，把任何 disabled 都算过的话，删掉 onChange 整个扫描仍全绿（实测）。
    expect(hasWriteBack('value={x} disabled={busy !== null}')).toBe(false)
    expect(hasWriteBack('value={x} readOnly={locked}')).toBe(false)
    // 非受控（defaultValue）本就不需要写回口，也就不该被这条判据点名。
    expect(isControlled('defaultValue={x}')).toBe(false)
  })

  it('没有一个受控控件是写不进去的', () => {
    const stranded = all
      .filter((item) => isControlled(item.props) && !hasWriteBack(item.props))
      .map((item) => `${item.file}:${item.line} <${item.tag}>`)
    expect(
      stranded,
      '这些控件声明了受控 value/checked 却没有 onChange/onInput，也没有 readOnly/disabled：' +
        '用户敲进去的字永远不会生效。补上写回口，或显式声明它只读。'
    ).toEqual([])
  })
})

describe('判据就是 React 运行时自己的规则', () => {
  // 上面那套静态判据是我写的正则；这条把它钉在 React 的实际行为上。React 换了规则、或我把判据
  // 悄悄放宽（比如让 `value` 单独存在也算过），这里会红。
  function warnings(element: Parameters<typeof renderToStaticMarkup>[0]): string {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderToStaticMarkup(element)
      return spy.mock.calls.map((call) => String(call[0])).join('\n')
    } finally {
      spy.mockRestore()
    }
  }

  it('缺写回口时 React 自己就报告它是只读的', () => {
    const message = warnings(createElement('input', { value: 'typed' }))
    expect(message).toContain('without an `onChange` handler')
    expect(message).toContain('read-only')
    // 同一句话对静态判据的两个"自洽"分支都不该出现。
    expect(warnings(createElement('input', { value: 'typed', onChange: () => {} }))).toBe('')
    expect(warnings(createElement('input', { value: 'typed', readOnly: true }))).toBe('')
  })

  it('启动对话框那两格名字输入是可写的', () => {
    // 事故现场本身：#120 的变异删的就是这两个 onChange。这里不重复渲染整个 NewTabSurface
    //（它要一整套 store mock），而是拿它那两格的真实属性文本过判据——源码变了这条就跟着变。
    const source = readFileSync(
      new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
      'utf8'
    )
    const names = controls(source, 'NewTabSurface.tsx').filter((item) =>
      /aria-label="(Agent|Tab) name"/.test(item.props)
    )
    expect(names).toHaveLength(2)
    for (const control of names) {
      expect(isControlled(control.props)).toBe(true)
      expect(/(^|\s)onChange\s*=/.test(control.props), `${control.line} 少了 onChange`).toBe(true)
    }
  })
})
