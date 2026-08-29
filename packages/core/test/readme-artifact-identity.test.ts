import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * README 陈述的产物身份必须与 vendor manifest 一致。
 *
 * 由来（实测，2026-09-25）：README「当前实现状态」一节写着固定 commit `aaadb684…`、protocol 16，
 * 而 `packages/core/vendor/ctxmux/darwin-arm64/manifest.json` 里是 `c168c0ab…` / protocol 17。
 * 那一行是**手抄**的——换 vendor 产物时没有任何东西会提醒它跟着改，于是它静静地漂了一整个
 * protocol 版本。同一节还写着「package bin 已删除」，而 `packages/core/package.json` 正声明着三个
 * bin；平台只支持 darwin-arm64 这条 fail-closed 边界则一个字都没写。
 *
 * 所以这道守卫**从 manifest 派生**，不维护第二份清单：手抄清单会和来源一起漂移，而漂移时清单
 * 自己不会响（AGENTS.md:96-99）——那正是这次要修的缺陷，不能在修它的过程中再造一个。
 *
 * 定位按**字段语义**（在 README 全文里找这个值），不按行号、不按小节标题：README 会被并行编辑，
 * 钉位置的守卫下一次改动就失守，而失守时它照样绿。
 */
describe('README 陈述的产物身份与 vendor manifest 一致', () => {
  const MANIFEST_PATH = new URL('../vendor/ctxmux/darwin-arm64/manifest.json', import.meta.url)
  const README_PATH = new URL('../../../README.md', import.meta.url)

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    source: { commit: string }
    product: { protocol: number }
    support: { platform: string; architecture: string }
  }
  const readme = readFileSync(README_PATH, 'utf8')

  it('抠得到东西：manifest 的字段和 README 正文都不是空的', () => {
    // 两边都抠空了的话，下面每一条「README 里出现了 manifest 的值」都会退化成「空串出现在空串里」
    // ——恒真。本仓记过这一族（抠空了的比对两边都是空串哈希），所以先证明两端真的有内容。
    expect(manifest.source.commit, 'manifest 里没有 source.commit').toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.product.protocol, 'manifest 里没有 product.protocol').toBeGreaterThan(0)
    expect(manifest.support.platform, 'manifest 里没有 support.platform').toBe('darwin')
    expect(manifest.support.architecture, 'manifest 里没有 support.architecture').toBe('arm64')
    expect(readme.length, 'README 读出来是空的').toBeGreaterThan(2000)
  })

  it('README 写的 commit 与 protocol 就是 manifest 里的那两个', () => {
    expect(
      readme,
      `README 写的 ctxmux commit 与 vendor manifest 对不上。manifest: ${manifest.source.commit}`
    ).toContain(manifest.source.commit)

    // protocol 只判「出现过这个数字」太弱：README 里到处是数字，17 撞上别的句子是迟早的事。
    // 所以连着 `protocol` 这个词一起抠，并且断言抠到了——抠不到时 match 是 null，而不是空串恒等。
    const stated = /protocol\s+(\d+)/i.exec(readme)
    expect(stated, 'README 里找不到 `protocol <数字>` 的写法——这条判据什么都没核').not.toBeNull()
    expect(
      Number(stated![1]),
      `README 写的 protocol 与 vendor manifest 对不上。manifest: ${manifest.product.protocol}`
    ).toBe(manifest.product.protocol)
  })

  it('README 如实陈述 bin 入口与 darwin-arm64 平台边界', () => {
    const bins = Object.keys(
      (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        bin?: Record<string, string>
      }).bin ?? {}
    )
    // 包真的声明了 bin，却在 README 里写「已删除」——那是一句反过来的谎，比漏写更坏。
    expect(bins, 'package.json 没有声明任何 bin').not.toEqual([])
    expect(readme, 'README 仍声称 package bin 已删除，而 package.json 正声明着它们').not.toMatch(
      /package bin[^。\n]*已删除/
    )
    for (const bin of bins) {
      expect(readme, `README 没有提到 bin 入口 ${bin}`).toContain(bin)
    }

    expect(readme, 'README 没有写明 darwin-arm64 平台边界').toContain(
      `${manifest.support.platform}-${manifest.support.architecture}`
    )
    // 边界是 fail-closed 的硬边界，README 必须点名那个错误码，否则读者会当成软约定。
    expect(readme, 'README 没有点名平台不符时抛的错误码').toContain('CTXMUX_ARTIFACT_INVALID')
  })
})
