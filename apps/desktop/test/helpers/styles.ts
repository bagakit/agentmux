import { readFileSync, readdirSync } from 'node:fs'

/**
 * 样式表现在按表面分成多个文件。契约测试读的是"整张样式表"，而不是某一个文件——
 * 如果它们各自硬编码一条路径，下一次按表面再拆一刀，它们会扫到空内容却全绿。
 *
 * 顺序与 index.css 的 @import 一致：层叠顺序即文件顺序，因此拼接结果与浏览器看到的一致，
 * 依赖先后的断言（比如"某条覆写排在被覆写者之后"）在这里仍然成立。
 */
const STYLES_DIR = new URL('../../src/renderer/src/styles/', import.meta.url)

function importOrder(): string[] {
  const index = readFileSync(new URL('index.css', STYLES_DIR), 'utf8')
  const order = [...index.matchAll(/@import\s+'\.\/([\w-]+\.css)'/g)].map((match) => match[1]!)
  if (order.length === 0) throw new Error('index.css 里没有 @import——样式入口变了，这个读取器要跟着改')
  const present = readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css') && name !== 'index.css')
  const missing = present.filter((name) => !order.includes(name))
  // 一个没被 @import 的样式文件是死文件：它的规则永远不生效，而契约测试会照常扫描它并放行。
  if (missing.length > 0) throw new Error(`这些样式文件没有被 index.css @import：${missing.join(', ')}`)
  return order
}

/**
 * 剥掉 CSS 注释，逐字节换成空格。
 *
 * 判「某条规则在不在场」的断言必须走这里。理由是实测出来的：#409 那道可达性守卫用
 * `/\.<class>[^,{]*\[data-attention/` 判「这个类与这个属性被同一条选择器选中」，而**这条规则的
 * 理由注释里恰好逐字写着那个选择器**——于是把组件的类名整个改掉（`.agent-avatar` → `.agent-glyph`，
 * 界面上再没有任何规则接得住），24 条照旧全绿：正则命中的是注释里的散文，不是规则。
 * 一句解释规则为何存在的注释，反过来成了「规则不存在」的通行证。
 *
 * 换成空格而不是删掉，是为了让行号与列号不动——报 `文件:行号` 的断言还要按剥完的文本定位。
 * stylesheet-organisation.test.ts 里那条 `-var(` 守卫早先自己做过一次同样的事（那次的教训是注释
 * 里的**告诫**会被当成违规），这里把它抽成共用的一处，两个方向的误判就只需要修一次。
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
}

/** 全部样式文件，按层叠顺序拼成一张表。 */
export function allStyles(): string {
  return importOrder()
    .map((name) => readFileSync(new URL(name, STYLES_DIR), 'utf8'))
    .join('\n')
}

/** 全部样式文件，剥掉注释——判「规则在不在场」一律用这个，见 `stripCssComments`。 */
export function allStyleRules(): string {
  return stripCssComments(allStyles())
}

/** 每个样式文件的内容，用于逐文件的断言（比如 :root 只能出现在 tokens.css）。 */
export function styleFiles(): Array<{ name: string; text: string }> {
  return importOrder().map((name) => ({
    name,
    text: readFileSync(new URL(name, STYLES_DIR), 'utf8')
  }))
}
