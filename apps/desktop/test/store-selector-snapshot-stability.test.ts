import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 一个 `useAppStore(selector)` 的返回值就是 `useSyncExternalStore` 的快照，React 用 `Object.is` 比它和上一次。
 * 所以 selector 里**就地新建的值**（`?? []`、`?? {}`、对象字面量、`.map`/`.filter`/`Object.keys`…）每次调用都是
 * 新引用，快照永远「变了」，组件当场进入无限重渲染 —— React error #185，控制台先报一句
 * "The result of getSnapshot should be cached to avoid an infinite loop"。
 *
 * 【为什么必须是源码扫描，不能靠普通测试】这一族缺陷在单元测试里**完全不可见**：selector 函数本身没有错，
 * 输入输出都对；错的是它每次返回新引用这个**性质**，只有真跑 `useSyncExternalStore` 的挂载才会炸。仓里的
 * 组件测试用的是 store 替身，走不到这条路径。
 *
 * 【真实发生过】`WorkspaceTopicsPanel` 的 `state.pinnedItems[SCRATCH_WORKSPACE_ID] ?? []`：
 * `togglePinnedItem` 清空时会 delete 掉整个 key，所以「缺 key」是常态；**没 pin 过东西的全新 userData 一进
 * 应用就死循环**，而日常在用的 profile 因为 key 在，返回稳定引用，一切正常。于是它表现成「打包验证过不了、
 * 本机跑却好好的」，在打包门禁里被记成一句 "Timed out waiting for file editing Workspace project" —— 症状，
 * 不是原因。同轮扫出的第二处 `App.tsx` 的 `state.layouts ?? {}` 是同一个形状，只因 `layouts` 通常非空而一直
 * 没炸；它的类型是非可空的 `Record<string, WorkspaceLayout>`、初值就是 `{}`，那个兜底是纯死代码，已删。
 *
 * 修法两条，按情况取：缺省值提成模块级常量（语义上真的可能缺 key），或直接删掉恒不触发的兜底（死代码）。
 * 派生型 selector（真的要 map/filter）应当把派生搬到组件里用 `useMemo`，而不是留在 selector 中。
 */

const RENDERER_ROOT = new URL('../src/renderer/src/', import.meta.url)

function sourceFiles(directory: URL, prefix = ''): { path: string; text: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = entry.name
    if (entry.isDirectory()) return sourceFiles(new URL(`${name}/`, directory), `${prefix}${name}/`)
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return []
    return [{ path: `${prefix}${name}`, text: readFileSync(new URL(name, directory), 'utf8') }]
  })
}

/** 每个 `useAppStore(` 调用的实参文本，按括号配平切出来（selector 体里带括号，正则截不准）。 */
function selectorBodies(text: string): string[] {
  const bodies: string[] = []
  const marker = 'useAppStore('
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
    let depth = 0
    const from = at + marker.length
    for (let cursor = from; cursor < text.length; cursor += 1) {
      const character = text[cursor]
      if (character === '(' || character === '[' || character === '{') depth += 1
      else if (character === ')' && depth === 0) { bodies.push(text.slice(from, cursor)); break }
      else if (character === ')' || character === ']' || character === '}') depth -= 1
    }
  }
  return bodies
}

/** selector 体里会新建引用的写法。命中即：这个 selector 的快照每次都是新对象。 */
const UNSTABLE_SNAPSHOT_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: '?? [] （空数组字面量兜底）', pattern: /\?\?\s*\[\s*\]/ },
  { name: '?? {} （空对象字面量兜底）', pattern: /\?\?\s*\{\s*\}/ },
  { name: '|| [] （空数组字面量兜底）', pattern: /\|\|\s*\[\s*\]/ },
  { name: '|| {} （空对象字面量兜底）', pattern: /\|\|\s*\{\s*\}/ },
  { name: '.map( / .filter( / .slice( / .concat( （派生新数组）', pattern: /\.(map|filter|slice|concat|flatMap|sort)\s*\(/ },
  { name: 'Object.keys / values / entries （派生新数组）', pattern: /Object\.(keys|values|entries|assign|fromEntries)\s*\(/ },
  { name: 'new Set / new Map （派生新集合）', pattern: /new\s+(Set|Map)\s*\(/ }
]

/**
 * 判据必须落在**返回值**上，不是函数体里出现过什么。带花括号的 selector 里 `.map`/`.flatMap` 常常只是中间
 * 步骤，最终 `return` 的是个字符串 —— 那种引用是稳定的，按函数体扫会把它误报成缺陷（初版就误报了
 * `SessionPane` 那条：内部 flatMap 派生数组，最终返回 `regionDisplayName(...)`，即 `string | undefined`）。
 * 所以这里只取表达式型 selector（`(state) => <表达式>`，没有花括号体）的那个表达式：它字面上就是返回值。
 * 带块体的 selector 交给下面单独的一条判据，只看它每个 `return` 后面跟的东西。
 */
function returnedExpressions(body: string): string[] {
  const arrow = body.indexOf('=>')
  if (arrow < 0) return []
  const returned = body.slice(arrow + 2).trim()
  if (!returned.startsWith('{')) return [returned]
  // 块体：逐个 return 语句取其表达式。`return` 后直接换行或分号的（return undefined）不产生引用。
  return [...returned.matchAll(/\breturn\s+([^\n;]+)/g)].map((match) => match[1]!.trim())
}

describe('useAppStore selector snapshots are referentially stable', () => {
  it('no selector builds a fresh reference on every call', () => {
    const files = sourceFiles(RENDERER_ROOT)
    // 自检：扫描根写错会让下面每条断言恒真。这正是本仓栽过的形态（扫描面为空＝白绿）。
    expect(files.length).toBeGreaterThan(50)

    const withSelectors = files
      .map((file) => ({ ...file, bodies: selectorBodies(file.text) }))
      .filter((file) => file.bodies.length > 0)
    // 自检：切不出任何 selector（比如 `useAppStore(` 改了名）会让整道守卫静默失效。
    expect(withSelectors.length).toBeGreaterThan(10)
    expect(withSelectors.reduce((total, file) => total + file.bodies.length, 0)).toBeGreaterThan(100)

    const offenders = withSelectors.flatMap((file) => file.bodies.flatMap((body) => (
      returnedExpressions(body).flatMap((returned) => (
        UNSTABLE_SNAPSHOT_PATTERNS
          .filter(({ pattern }) => pattern.test(returned))
          .map(({ name }) => `${file.path}: 返回 \`${returned}\` —— ${name}`)
      ))
    )))

    expect(offenders, [
      '这些 selector 每次调用都返回新引用，useSyncExternalStore 会判定快照一直在变，挂载即无限重渲染：',
      ...offenders,
      '',
      '修法：缺省值提成模块级常量；恒不触发的兜底直接删；真要派生就搬进组件用 useMemo。'
    ].join('\n')).toEqual([])
  })
})
