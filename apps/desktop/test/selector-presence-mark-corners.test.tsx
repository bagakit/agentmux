import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'
import { SelectorPresence } from '../src/renderer/src/components/SelectorList.js'
import {
  PRESENCE_MARK_CORNERS,
  type PresenceMarkCorner
} from '../src/renderer/src/lib/presence-mark-corner.js'

/**
 * 叠压头像簇里，「这个 Agent 在等你 / 出错了」必须看得见。
 *
 * 病史：`.selector-presence__slot + .selector-presence__slot` 用负 margin 把每一枚后续头像拉到
 * 前一枚之上，z-index 随 DOM 序递增——**右压左**，每一枚自己的右 6px 被右邻座整枚盖住。而注意力
 * 角标此前钉在 `right: -2px`，横向区间整个落在被盖的带子里：除簇尾那一枚外，全产品最响的通报在
 * 任何多 Agent 簇里都看不见。这不是装饰缺失，是把状态信号钉在了几何上注定被盖的那条缘上。
 *
 * 判据从**样式表实读**（头像尺寸、叠压量、角标定位全部扫出来），不手抄：手抄的数字会和样式表一起
 * 漂移，而漂移那天它自己不会响。每处扫描都先断言扫到了东西——扫到空内容是本仓既有的第三种白绿。
 */

const STYLES = new URL('../src/renderer/src/styles/', import.meta.url)

function sheet(name: string): string {
  return readFileSync(new URL(name, STYLES), 'utf8')
}

/** 某条规则的声明体。找不到即 undefined，由调用处断言——静默返回空串会让后面每条判据恒真。 */
function ruleBody(css: string, selector: string): string | undefined {
  // 先剥注释：规则头捕获的是上一个 `}` 之后的全部文本，注释留在里面会让 trim() 后的头对不上，
  // 于是每条规则都"没扫到"。本轮实测踩过——给规则加一行说明就把扫描打空了。
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
  expect(rules.length, `${selector}：一条 CSS 规则都没解析出来，这份扫描在空转`).toBeGreaterThan(0)
  return rules.find(([, head]) => head!.trim() === selector)?.[2]
}

/** `px` 取值。取不到返回 null，让调用处把「没扫到」和「扫到 0」分开。 */
function px(body: string, property: string): number | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(-?[\\d.]+)px`, 'u').exec(body)
  return match ? Number(match[1]) : null
}

/** 从 tokens.css 读一个长度 token。 */
function token(name: string): number {
  const match = new RegExp(`${name}\\s*:\\s*(-?[\\d.]+)px`, 'u').exec(sheet('tokens.css'))
  expect(match, `tokens.css 里没扫到 ${name}——这份几何判据在空转`).not.toBeNull()
  return Number(match![1])
}

describe('叠压头像簇的角位分配', () => {
  /**
   * 几何：头像 18px、叠压 6px，所以右邻座盖住 [W-overlap, ∞)。角标落在哪一侧决定它可不可见。
   *
   * 这一条是本文件的核心判据，也是变异要打的靶：把 `.agent-avatar__status` 的 `left` 改回
   * `right`，它必须转红。
   */
  it('注意力角标的横向区间与右邻座的覆盖区间不相交', () => {
    const avatarSize = token('--agent-avatar-size')
    const overlap = token('--sp-3')
    expect(avatarSize, '头像尺寸扫成了 0').toBeGreaterThan(0)
    expect(overlap, '叠压量扫成了 0').toBeGreaterThan(0)

    // 叠压写在相邻选择器上，负值走 calc。这条自检确保上面那个 overlap 真的是这里用的那个 token。
    const stacking = ruleBody(sheet('selector.css'), '.selector-presence__slot + .selector-presence__slot')
    expect(stacking, '叠压规则没扫到——右压左这个前提没被证实，下面的判据全部在空转').toBeDefined()
    expect(stacking).toMatch(/margin-left:\s*calc\(-1\s*\*\s*var\(--sp-3\)\)/u)

    // 右邻座覆盖自身坐标系里的 [avatarSize - overlap, ∞)。
    const coveredFrom = avatarSize - overlap

    const avatarCss = sheet('agent-avatar.css')
    const status = ruleBody(avatarCss, '.agent-avatar .agent-avatar__status')
    expect(status, '注意力角标的规则没扫到').toBeDefined()

    // 9px 是 waiting/blocked/error 三态下 `.status__dot` 的实测尺寸，同样从样式表扫。
    const dot = ruleBody(sheet('base.css'), '.status--waiting .status__dot, .status--blocked .status__dot')
    expect(dot, '注意力状态点的规则没扫到').toBeDefined()
    const markSize = px(dot!, 'width')
    expect(markSize, '角标尺寸扫成了 null').not.toBeNull()

    // 外伸量在记号自己的规则里，方位由 [data-corner] 翻译——所以横向落在哪一边，问的是分配表。
    const inset = px(status!, '--mark-inset')
    expect(inset, '注意力角标没声明 --mark-inset，方位规则会拿不到外伸量').not.toBeNull()
    expect(
      PRESENCE_MARK_CORNERS.status,
      '注意力角标被分到了右侧——那是右邻座盖住的那条带子'
    ).toMatch(/-left$/u)

    // 左侧落角的横向区间是 [inset, inset + size]，必须整个落在覆盖区间左边。
    const markRight = inset! + markSize!
    expect(
      markRight,
      `注意力角标右边界 ${markRight}px 伸进了右邻座覆盖的 [${coveredFrom}px, ∞)`
    ).toBeLessThanOrEqual(coveredFrom)
  })

  /**
   * 四种记号两两不同角，且注意力与归并计数（两者可同时在场）都在可见带上。
   *
   * 只测注意力会放过「归并计数又被推回被盖的右缘」——A2 明确点了这个缺陷，所以这里判的是整份分配。
   *
   * 「可见」不引一份手写的可见角清单：那会变成第二份真相，而且它与几何漂开的那天自己不会响。
   * 可见性从上一条已经证实过的几何直接推——右压左，所以落在 `-left` 的那两个角在上。
   */
  it('四种记号两两不落在同一角，通报类的两种都在可见带上', () => {
    const corners = Object.values(PRESENCE_MARK_CORNERS)
    expect(corners.length, '分配表是空的').toBeGreaterThan(0)
    expect(new Set(corners).size, `有两种记号落在同一角：${corners.join(', ')}`).toBe(corners.length)

    // 通报类：看不见就等于没通报。整表钉死而不写 every——空集合上的 every 恒真。
    expect(PRESENCE_MARK_CORNERS.status).toBe('top-left')
    expect(PRESENCE_MARK_CORNERS.count).toBe('bottom-left')

    // 叠压是右压左（上一条从样式表证过），于是可见带就是左侧两角。通报类两种都必须落在那里。
    expect(PRESENCE_MARK_CORNERS.status).toMatch(/-left$/u)
    expect(PRESENCE_MARK_CORNERS.count).toMatch(/-left$/u)
  })

  /**
   * 样式表不再各自写死方位，而是把「某个角」翻译成 top/left/right/bottom；渲染出的 `data-corner`
   * 才是落角。这一条守两件事：四条翻译规则都在且译对，以及组件真的按分配表发出了 `data-corner`。
   *
   * 这比「逐条核 CSS 里的方位」更强：方位在样式表里只剩一份通用翻译，改分配表就当场改变落角，
   * 不存在「表改了、CSS 忘了改」这种两份真相。
   */
  it('样式表把角翻译成方位，组件按分配表发出落角', () => {
    const avatarCss = sheet('agent-avatar.css')
    const expectedEdges: Record<PresenceMarkCorner, readonly [string, string]> = {
      'top-left': ['top', 'left'],
      'bottom-left': ['bottom', 'left'],
      'top-right': ['top', 'right'],
      'bottom-right': ['bottom', 'right']
    }
    // 四个角各有一条翻译规则，且译得对。整表遍历而不是挑一个——漏译一个角，下一次改分配就静默失位。
    for (const [corner, [vertical, horizontal]] of Object.entries(expectedEdges)) {
      const body = ruleBody(avatarCss, `.agent-avatar [data-corner='${corner}']`)
      expect(body, `${corner} 没有翻译规则——把分配表指向这个角就会失位`).toBeDefined()
      expect(body).toMatch(new RegExp(`${vertical}:\\s*var\\(--mark-inset\\)`, 'u'))
      expect(body).toMatch(new RegExp(`${horizontal}:\\s*var\\(--mark-inset\\)`, 'u'))
    }

    // 三枚记号同时在场，逐一核对渲染出的 data-corner 与分配表一致。
    const markup = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'agent', providerId: 'codex', state: 'waiting', count: 3, appearance: { badge: 'shield' }
    }))
    const rendered = new Map(
      [...markup.matchAll(/class="(agent-avatar__[a-z]+)[^"]*"\s+data-corner="([a-z-]+)"/gu)]
        .map(([, className, corner]) => [className!, corner!])
    )
    expect(rendered.size, '一枚带 data-corner 的记号都没渲染出来——这条断言在空转').toBeGreaterThan(0)
    expect(Object.fromEntries(rendered)).toEqual({
      'agent-avatar__status': PRESENCE_MARK_CORNERS.status,
      'agent-avatar__count': PRESENCE_MARK_CORNERS.count,
      'agent-avatar__badge': PRESENCE_MARK_CORNERS.badge
    })
  })

  /**
   * ≥3 枚的簇，中间那一枚带注意力：它的角标必须渲染，且簇的叠压关系确实成立。
   *
   * A1 点名要这个场景——单枚簇今天就可见，缺陷只在多枚簇里显形。
   */
  it('三枚簇里，非最后一枚的注意力角标渲染在可见的那一侧', () => {
    const agents = ['alpha', 'beta', 'gamma'].map((key, index) => ({
      key,
      label: key,
      providerId: 'codex' as const,
      // 中间那一枚在等你——它既不是簇尾，也就是此前看不见的那一枚。
      state: (index === 1 ? 'waiting' : 'running') as 'waiting' | 'running',
      ...(index === 1 ? { count: 2 } : {})
    }))
    const markup = renderToStaticMarkup(createElement(SelectorPresence, { agents }))

    const slots = [...markup.matchAll(/class="selector-presence__slot"/gu)]
    expect(slots.length, '簇没渲染出三枚——这个场景在空转').toBe(3)

    // 注意力角标在场。它此前也"在场"，缺陷是位置，所以位置由上面那条几何判据守。
    expect(markup).toContain('agent-avatar__status status__dot')
    expect(markup).toContain('agent-avatar__count')

    // 叠压方向：z-index 随 DOM 序递增，所以后面的盖前面的。这是"右缘被盖"的来源。
    const zIndexes = [...markup.matchAll(/z-index:\s*(\d+)/gu)].map(([, value]) => Number(value))
    expect(zIndexes.length, 'z-index 一个都没扫到，叠压方向这条前提没被证实').toBe(3)
    expect(zIndexes).toEqual([...zIndexes].sort((a, b) => a - b))
  })
})
