import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

/**
 * 等待态只有两档，且各自只有一份实现。
 *
 * 密度合同 :183 与 :897 定的规矩：**行内**等待（按钮里、行首、面板 header 这类 11–16px 的位置）
 * 用全 App 唯一那条通用 spinner `.spin`；**占满一格/一块/整页**的等待用 `FullPageLoadingSurface`
 * 的品牌语言。理由写在合同里：十六处行内加载各自长出一个品牌动画等于没有品牌，而把最显眼的
 * 位置让给通用转圈则是把门面让给了最没有信息的图形。
 *
 * 病史（2026-09-25）：`browser.css` 私藏了一条 `@keyframes browser-rsi-spin`，`to { rotate(360deg) }`
 * 与 `.spin` 逐字节相同，只是 `.9s` 对 `.8s`。三个调用点都是同一个 `LoaderCircle`、同样的 11–13px。
 * 它不是第二种设计，是同一个决定被做了第二遍——而当时没有任何测试会因为它变红。
 *
 * 判据都从**样式表与源码实读**，不维护手抄清单：清单会和来源一起漂移，漂移时它自己不会响。
 */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src')

function sourceFiles(): string[] {
  return readdirSync(RENDERER, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.tsx') || entry.endsWith('.ts'))
    .map((entry) => join(RENDERER, entry))
}

describe('等待态的两档语汇', () => {
  /**
   * 旋转动画全 App 只有一条。
   *
   * 判的是 `@keyframes` 里**真的画旋转**的那些，不是名字里有没有 "spin"——换个名字叫
   * `busy-turn` 同样是第二条，按名字判等于给绕过留了门（记忆 guard-blindness-patterns）。
   */
  it('只有一条旋转 keyframes，第二条就是同一个决定做了两遍', () => {
    const styles = allStyles()
    const frames = [...styles.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n?\}/gu)]
    expect(frames.length, '一条 @keyframes 都没扫到——这份扫描在空转').toBeGreaterThan(0)

    const rotations = frames
      .filter(([, , body]) => /\brotate\(\s*-?360deg\s*\)/u.test(body!))
      .map(([, name]) => name!)
    expect(
      rotations,
      `旋转动画不止一条：${rotations.join(', ')}。行内等待只用 .spin——第二条转圈是同一个决定做了两遍`
    ).toEqual(['spin'])
  })

  /**
   * 行内 spinner 待在行内尺度里。
   *
   * 一个 20px+ 的通用转圈意味着它已经离开按钮、去占一块面了——那是品牌语言该出场的位置。
   * 上界取 16：合同写的是 "11–16px 的位置"。
   *
   * **这条只覆盖 `size` 与 spinner 写在同一行的那种**，也就是绝大多数调用点。实测过它的边界：
   * 把 `WorkflowStatusGlyph` 的默认形参从 12 改成 28，这条**不红**——尺寸经一层组件的默认值
   * 间接传下去时，扫描面上那一行只有类名没有数字。写在这里而不是假装覆盖全：一条读起来比实际
   * 强的断言，比一条明说自己边界的断言更危险。跨组件的尺寸流要靠渲染快照判，不是靠扫源码。
   */
  it('通用 spinner 只出现在行内尺度，放大就该换成品牌语言（限同行 size）', () => {
    const oversized: string[] = []
    let sized = 0
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('"spin"') && !source.includes("'spin'")) continue
      for (const line of source.split('\n')) {
        if (!/\bspin\b/u.test(line)) continue
        const size = /size=\{(\d+)\}/u.exec(line)
        if (!size) continue
        sized += 1
        if (Number(size[1]) > 16) oversized.push(`${file.slice(RENDERER.length + 1)}: size=${size[1]}`)
      }
    }
    expect(sized, '一处带 size 的 .spin 都没扫到——这条判据在空转').toBeGreaterThan(0)
    expect(oversized, `这些通用 spinner 超出了行内尺度（>16px），该换成 FullPageLoadingSurface`).toEqual([])
  })

  /**
   * 品牌加载表面只有一份实现，且真的接在产品上。
   *
   * 不钉调用者名单——这个 Feature 的目标恰恰是让更多整页加载收敛过来，名单只会把进展报成缺陷
   * （loading-surface-callers.test.ts 已经因此删过一次名单）。这里判的是"唯一"与"非零"。
   */
  it('品牌加载表面只有一份，且有产品调用者', () => {
    const definition = join(RENDERER, 'components', 'FullPageLoadingSurface.tsx')
    const files = sourceFiles()
    expect(files, '定义文件不在扫描面里——下面的判据分不清"没有调用者"和"路径写错了"').toContain(definition)

    // 导出这个名字的地方只能有一处：第二处就是另一套品牌大屏。
    const definers = files.filter((file) => /export function FullPageLoadingSurface\b/u.test(readFileSync(file, 'utf8')))
    expect(definers, '品牌加载表面有第二份实现').toEqual([definition])

    const callers = files.filter((file) => file !== definition && readFileSync(file, 'utf8').includes('FullPageLoadingSurface'))
    expect(callers.length, '品牌加载表面没有任何产品调用者——竖切未闭合').toBeGreaterThan(0)
  })

  /**
   * 「running 就转圈」这个决定只由一层做。
   *
   * 病史（2026-09-25）：`WorkflowStatusGlyph` 与它调用的 `WorkflowSemanticIcon` 各自判了一次
   * `status === 'running'` 并各自挂一个 spin 类，渲染出来是 `class="… spin spin"`（实测）。
   * 浏览器不在乎重复类名，所以它安静地活了很久——但那正是同一个决定写了两遍：两处将来会各自
   * 漂移，而且上一次统一 spinner 的改动同时改了这两行，恰恰说明它们必须一起改才对。
   *
   * 判据落在**渲染出来的 class 列表**上，不落在源码：源码里两处 `'spin'` 分属两个文件，
   * 读源码的扫描看不出它们会叠加。
   */
  it('转圈类只挂一次——重复即同一个决定做了两遍', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { WorkflowStatusGlyph } = await import('../src/renderer/src/components/workflow/WorkflowStatusGlyph.js')

    const markup = renderToStaticMarkup(createElement(WorkflowStatusGlyph, { status: 'running' }))
    const classes = /class="([^"]*)"/u.exec(markup)?.[1]?.split(/\s+/u) ?? []
    // 非空见证：一个类都没读到时，下面的计数会是 0，"不重复"就成了恒真的白绿。
    expect(classes.length, '渲染结果里一个 class 都没读到——这条判据在空转').toBeGreaterThan(0)
    expect(classes, 'running 状态下没挂上通用转圈类').toContain('spin')
    expect(
      classes.filter((name) => name === 'spin').length,
      `转圈类挂了不止一次（${classes.join(' ')}）：调用方和组件各判了一次 running，` +
        '这个决定该只归组件所有'
    ).toBe(1)
  })
})
