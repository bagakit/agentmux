import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

/**
 * 「多个 Region 时，当前聚焦在哪一格」必须看得出来（#339，用户原话：「多个 region, 当前聚焦在哪里,
 * 看不出俩」）。
 *
 * 这条守的不是某一个 CSS 声明长什么样——那是设计的自由。守的是这件事**有没有人在负责**：
 *   1. 组件真的按 `activeRegionId` 分岔，而不是给每一格同一个类名（取值层）
 *   2. 那个类名真的对应到有实际视觉效果的声明，而不是一条空规则（表达层）
 *   3. 焦点与非焦点在**同一个属性**上取不同值，否则"有声明"也可能是两边都一样（差别层）
 *
 * 为什么第 2、3 条要分开：本仓 #111 的先例是「CSS 守卫只查选择器名存在，删掉承重声明体全绿」。
 * 只判 `.workbench-region--active` 这个选择器在不在，把它的 body 清空即可绕过——屏幕上焦点
 * 彻底消失，而守卫沉默。反过来只判「body 非空」也不够：写一条与默认态**取值相同**的声明
 * （比如都是 transparent）同样让焦点不可见。
 *
 * 键盘那一侧已经在场且可达（`lib/workbench-shortcuts.ts:268` 的 `focus-region.{left,right,up,down}`
 * 走 `store.focusRegion`），所以用户能把焦点切到看不见的地方——这正是"看不出来"最难受的现场：
 * 按了键，界面上没有任何东西变。
 */

const WORKBENCH_TSX = new URL(
  '../src/renderer/src/components/WorkspaceWorkbench.tsx',
  import.meta.url
)

/** 注释里描述规则的文字不是规则本身（与 surface-selection-contract 同一条处理）。 */
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

type Rule = { selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = []
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ')
    if (selector.startsWith('@')) continue
    out.push({ selector, body: match[2]! })
  }
  return out
}

/** 一条规则里声明的属性 → 取值。同一属性重复声明时后者胜（层叠内规则内的顺序）。 */
function declarations(rule: Rule): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of rule.body.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const property = part.slice(0, at).trim()
    if (!property) continue
    out.set(property, part.slice(at + 1).trim())
  }
  return out
}

/**
 * 某个类名恰好命中的规则们（不含把它当祖先或兄弟的选择器）。
 *
 * 用词法边界收紧：`.workbench-region` 是 `.workbench-region--active` 与
 * `.workbench-region-split` 的前缀，`includes` 会把三者混成一堆，于是"默认态"里混进焦点态的
 * 声明，第 3 条差别断言当场退化成恒真（记忆 counting-a-symbol-misses-other-spellings 的同族：
 * 判据比它要防的拼法更粗）。
 */
function rulesForClass(className: string): Rule[] {
  const exact = new RegExp(`\\.${className}(?![\\w-])`)
  return rules().filter((rule) =>
    rule.selector.split(',').some((part) => exact.test(part.trim()))
  )
}

/**
 * 组件里 `activeRegionId` 参与计算的那个 className 表达式。
 *
 * 按 AST 取而不是 grep：判据要落在「这个三元的两个分支给出**不同**的类名」上。
 * 文本判据看不出 `? 'workbench-region--active' : 'workbench-region--active'`
 * 与 `? '' : ''` 这两种把分岔抹平的写法（前者每格都亮，后者每格都不亮，用户看到的都是
 * "分不出焦点"）。
 */
function activeRegionConditional(): { whenActive: string; whenNot: string } | null {
  const text = readFileSync(WORKBENCH_TSX, 'utf8')
  const source = ts.createSourceFile(
    'WorkspaceWorkbench.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let found: { whenActive: string; whenNot: string } | null = null
  const walk = (node: ts.Node): void => {
    if (
      ts.isConditionalExpression(node) &&
      node.condition.getText(source).includes('activeRegionId')
    ) {
      found = {
        whenActive: node.whenTrue.getText(source),
        whenNot: node.whenFalse.getText(source)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

describe('Region 焦点必须看得出来（#339）', () => {
  it('自检：能按类名精确取到规则，且不把前缀相同的邻居算进来', () => {
    // 认不出任何规则的读取器会让下面的断言因为"没找到"而全绿。这条同时钉住词法边界：
    // `.workbench-region-split` 与 `.workbench-region--active` 都以 `.workbench-region` 开头，
    // 混进来就会污染"默认态有哪些声明"。
    const exact = /\.workbench-region(?![\w-])/
    const base = rulesForClass('workbench-region')
    expect(base.length, '读不到 .workbench-region 的规则——样式入口或类名变了').toBeGreaterThan(0)
    // 判据落在**命中的那一支**上，不在整条选择器字符串上：`.workbench-region-split,
    // .workbench-region` 是一条合法的逗号组，其中一支正是我们要的；按整条判会把它当违规。
    for (const rule of base) {
      const matched = rule.selector.split(',').map((part) => part.trim()).filter((part) => exact.test(part))
      expect(matched.length, `${rule.selector} 被取进来了却没有任何一支精确命中`).toBeGreaterThan(0)
      for (const part of matched) {
        expect(part, `词法边界失效：${part} 被当成了 .workbench-region 本身`).not.toMatch(
          /\.workbench-region(?:--|-)\w/
        )
      }
    }
    // 反向：焦点态那条确实取得到，且没被上面那组吞掉。
    expect(rulesForClass('workbench-region--active').length).toBeGreaterThan(0)
    // 判据自己认得出该拒的拼法——否则"没找到违规"与"认不出违规"在结果上同形。
    expect(exact.test('.workbench-region--active')).toBe(false)
    expect(exact.test('.workbench-region-split')).toBe(false)
    expect(exact.test('.workbench-region')).toBe(true)
  })

  it('组件按 activeRegionId 分岔，且两个分支给出不同的类名', () => {
    const conditional = activeRegionConditional()
    expect(
      conditional,
      'WorkspaceWorkbench 里没有任何按 activeRegionId 分岔的三元——每一格长得一样，焦点无从表达'
    ).not.toBeNull()
    // 两个分支必须真的不同。写成同一个值（两边都加类、或两边都不加）在类型与文本上都合法，
    // 而屏幕上就是"分不出哪一格是焦点"。
    expect(
      conditional!.whenActive.trim(),
      '按 activeRegionId 分岔的两个分支给出同一个类名，等于没有分岔'
    ).not.toBe(conditional!.whenNot.trim())
    // 焦点那一侧必须真的给出一个类名，不能是空串（空串意味着焦点态没有任何样式挂载点）。
    expect(conditional!.whenActive, '焦点分支没有给出类名').toMatch(/[a-z]/)
  })

  it('焦点类名有承重声明，不是一条空规则', () => {
    const active = rulesForClass('workbench-region--active')
    const properties = new Set(active.flatMap((rule) => [...declarations(rule).keys()]))
    // #111 的先例：只判选择器在不在场，把 body 清空即可让焦点在屏幕上彻底消失而守卫沉默。
    expect(
      [...properties],
      '.workbench-region--active 没有任何声明——焦点态是一条空规则，屏幕上看不出任何差别'
    ).not.toEqual([])
  })

  it('焦点与非焦点在同一个属性上取到不同的值', () => {
    const base = rulesForClass('workbench-region')
    const active = rulesForClass('workbench-region--active')
    const baseDeclarations = new Map<string, string>()
    for (const rule of base) for (const [key, value] of declarations(rule)) baseDeclarations.set(key, value)

    const differing: string[] = []
    for (const rule of active) {
      for (const [property, value] of declarations(rule)) {
        // 默认态没声明这个属性 → 焦点态是在无到有地加东西，那本身就是差别。
        if (!baseDeclarations.has(property)) {
          differing.push(property)
          continue
        }
        if (baseDeclarations.get(property) !== value) differing.push(property)
      }
    }
    // 「有声明」不等于「有差别」：焦点态写一条与默认态逐字相同的声明（本仓默认态就有一条
    // `box-shadow: inset 0 0 0 1px transparent` 占位），编译与上面那条断言都过，而用户
    // 看到的两格一模一样。
    expect(
      differing,
      '焦点态的每一条声明都与默认态取值相同——两格在屏幕上没有任何差别'
    ).not.toEqual([])
  })

  it('焦点表达画在定位不透明内容之上——不是 inset 阴影，也不是 outline', () => {
    // 上面三条全绿也可能一个像素都画不出来。这条已经**两次**抓到真缺陷，判据也因此换过两次：
    //
    // 第一次：`inset box-shadow` 属元素**自身的背景层**，子元素背景画在它之上。当时的判据是
    // 「必须是 outline 族或 ::after 覆盖层」——它挡住了 inset 阴影，但为下一个坏修复背了书。
    //
    // 第二次（本条现在的形状）：**outline 也不行**。CSS 2.1 Appendix E 的绘制顺序里父元素 outline 是
    // 第 7 步，`z-index: auto` 的**定位后代**是第 8 步——定位后代画在父层 outline 之后是规范保证的。
    // Region 内恰好有这种后代：`.terminal-view`（terminal.css:9 `position: relative`）带满铺不透明
    // 背景，于是 terminal 与 agent 两种区（终端优先产品里最常见的两种）焦点框完全不可见，而当时
    // 5/5 全绿。**判据的对象不是「属性属于哪一族」，而是「这条声明能不能排到定位内容之上」**——
    // 只有真正参与层叠的定位覆盖层能做到，故只认那一种，且必须逐项检查它排上去的三个条件。
    //
    // 同族的绕过形状（都匹配"选择器带 ::after"这种旧判据、都实测不可见）：无 position 的伪元素是
    // 零尺寸在流块；有 position 无 z-index 的与内容同序、被后面的定位兄弟盖住。所以三项缺一不可。
    //
    // **两个类名都要判**：这个毛病同时存在于 Region 与 Pane 组两级（`.pane-group` 的内容行就是
    // `.workbench-region`，定位不透明，同样实测不可见）。只钉一处会让另一处静默留在旧形状——
    // 记忆 duplicated-rule-defeats-the-fix 的形状：同一件事有两个写入点时，改一处的人以为改完了。
    const MIN_OVERLAY_Z = 37 // Region 内最高的常驻面是 terminal.css:141 的 36
    for (const className of ['workbench-region--active', 'pane-group--focused']) {
      const overlays = rules().filter((rule) =>
        rule.selector
          .split(',')
          .some((part) => new RegExp(`\\.${className}\\b[^,]*::(?:after|before)`).test(part.trim()))
      )
      expect(
        overlays.length,
        `.${className} 的焦点态没有伪元素覆盖层规则。inset 阴影画在自身背景层、outline 画在定位后代` +
          '之下（规范绘制顺序 7 vs 8），Region 里的 `.terminal-view` 正是定位不透明后代——' +
          '那两种画法在 terminal/agent 区一个像素都出不来（#339 两次的真因）。'
      ).toBeGreaterThan(0)

      // 覆盖层要真的排到内容之上，三个条件缺一不可，逐项报告缺的是哪一个。
      const merged = new Map<string, string>()
      for (const overlay of overlays) {
        for (const [property, value] of declarations(overlay)) merged.set(property, value)
      }
      expect(
        merged.get('position'),
        `.${className} 的覆盖层没有 position: absolute——无定位的伪元素是零尺寸在流块，被定位内容盖住`
      ).toBe('absolute')
      const z = Number.parseInt(merged.get('z-index') ?? '', 10)
      expect(
        z,
        `.${className} 的覆盖层 z-index 是 ${merged.get('z-index') ?? '（未声明）'}，压不过 Region 里` +
          `最高的常驻面（terminal-service-window 的 36）——同序或更低会被后面的定位兄弟盖住`
      ).toBeGreaterThanOrEqual(MIN_OVERLAY_Z)
      // 画得出来还不够：它不能吃掉指针事件，否则终端整块点不动（焦点框是告示不是遮挡）。
      expect(
        merged.get('pointer-events'),
        `.${className} 的覆盖层没有 pointer-events: none——它铺满整格，会吃掉终端/编辑器的全部点击`
      ).toBe('none')
    }

    // 自检：判据认得出该拒的每一种拼法，否则"没找到违规"与"认不出违规"在结果上同形。
    // 三种都曾经是（或差一点成为）本仓的真实形状：前两种是 #339 两轮修复各自的原样声明，
    // 第三种是审计实测能绕过旧判据且 5/5 全绿的那个。
    const rejected = [
      { why: 'inset 阴影（第一次事故的原样）', body: 'box-shadow: inset 0 0 0 1px var(--green-line);' },
      { why: 'outline（第二次事故的原样）', body: 'outline-color: var(--green-2);' },
      { why: '无 position 的伪元素（审计实测可绕过旧判据）', body: "content: ''; border: 2px solid var(--green-2);" }
    ]
    for (const { why, body } of rejected) {
      const probed = declarations({ selector: '.probe', body })
      expect(
        probed.get('position') === 'absolute' &&
          Number.parseInt(probed.get('z-index') ?? '', 10) >= MIN_OVERLAY_Z &&
          probed.get('pointer-events') === 'none',
        `判据把「${why}」错认成能画在定位内容之上——那正是它要挡的形状`
      ).toBe(false)
    }
    // 反向自检：正确的那种拼法必须被接受，否则这一族退化成"什么都拒"的恒红/死判据。
    const accepted = declarations({
      selector: '.probe::after',
      body: "content: ''; position: absolute; z-index: 37; inset: 0; pointer-events: none; border: 2px solid var(--green-2);"
    })
    expect(
      accepted.get('position') === 'absolute' &&
        Number.parseInt(accepted.get('z-index') ?? '', 10) >= MIN_OVERLAY_Z &&
        accepted.get('pointer-events') === 'none',
      '判据认不出正确的定位覆盖层写法——那它挡的不是坏形状而是所有形状'
    ).toBe(true)
  })

  /**
   * 环宽是**一处**：CSS 画它，而进程外的原生视图要按同一个宽度让位。
   *
   * browser 那格的内容是窗口级的原生 `WebContentsView`，合成在**全部** renderer 像素之上——连上面
   * 那个覆盖层也盖不住它。唯一修法是让 `setBounds` 内缩同样的宽度（`nativeBoundsClearOfFocusRing`）。
   * 那个消费者在进程边界之外、读不到 CSS 规则，只能从计算样式取一个自定义属性；于是这个数必须有名字。
   *
   * 这条守的是那个名字两侧都在场：tokens.css 声明它、CSS 用它画、TS 那侧按同一个名字取。任一侧改名
   * 或改成手抄字面量，原生视图就会静默回到满铺（读不出数时按设计返回 0），而两侧行为测试各自全绿。
   */
  it('焦点框宽度只有一处：CSS 与原生视图取值方按同一个自定义属性', () => {
    const PROPERTY = '--region-focus-ring-width'
    // tokens.css 里声明了它（allStyles 已合并全部样式表）。
    expect(
      new RegExp(`${PROPERTY}\\s*:\\s*[0-9]`).test(styles),
      `${PROPERTY} 没有在样式里声明取值——CSS 侧的环宽会退化成 0（记忆 injected-css-property-declare-default）`
    ).toBe(true)

    // 两个焦点态覆盖层都必须**用**它画，而不是各自写死 2px。
    for (const className of ['workbench-region--active', 'pane-group--focused']) {
      const overlays = rules().filter((rule) =>
        rule.selector
          .split(',')
          .some((part) => new RegExp(`\\.${className}\\b[^,]*::(?:after|before)`).test(part.trim()))
      )
      const widths = overlays.flatMap((rule) =>
        [...declarations(rule)]
          .filter(([property]) => property === 'border' || property.startsWith('border-'))
          .map(([, value]) => value)
      )
      expect(
        widths.length,
        `.${className} 的覆盖层没有任何 border 声明——那圈框没有可见的边`
      ).toBeGreaterThan(0)
      for (const value of widths) {
        expect(
          value.includes(`var(${PROPERTY}`),
          `.${className} 的覆盖层边宽写着 \`${value}\`，不是从 ${PROPERTY} 取的——` +
            'browser 那格的原生视图按那个属性让位，两边分头写就会静默错开'
        ).toBe(true)
      }
    }

    // 原生视图那一侧按同一个名字取值。判 import 关系不够（导入了不用照样过），所以判它把这个属性名
    // 交给 getPropertyValue——判据落在「取的是哪一个属性」上，这正是上一轮 outline-offset 走错的位置。
    const boundsSource = readFileSync(
      new URL('../src/renderer/src/lib/browser-bounds-sync.ts', import.meta.url),
      'utf8'
    )
    const reads = [...boundsSource.matchAll(/getPropertyValue\(\s*([A-Za-z_$][\w$.]*|'[^']*')/g)]
      .map((match) => match[1]!)
    expect(
      reads.length,
      'getPropertyValue 取值位抽取器一个都没找到——原生视图那侧没有从计算样式读环宽，下面那条是死代码'
    ).toBe(1)
    // 允许经由常量转发（本仓就是 FOCUS_RING_WIDTH_PROPERTY），但那个常量必须绑定到同一个属性名。
    const read = reads[0]!
    const bound = read.startsWith("'")
      ? read.slice(1, -1)
      : new RegExp(`${read}\\s*=\\s*'([^']*)'`).exec(boundsSource)?.[1]
    expect(
      bound,
      `原生视图那侧读的是 \`${read}\`，解析不到它绑定的属性名——取值方与 CSS 侧无法对齐`
    ).toBe(PROPERTY)
  })
})
