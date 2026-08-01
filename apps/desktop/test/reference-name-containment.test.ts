import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 参考项目名不得出现在任何被 git 跟踪的文件里。
 *
 * 用户的原话是「对，参考项目名不能泄露」。判据不是"出现了名字"而是**会不会离开本机**：
 * `ideas/` 被 .git/info/exclude 挡在仓库外，不算泄漏；被 git 跟踪的文件会跟着仓库走，算。
 *
 * 这条测试存在的直接原因是一次**清理之后没留检测器**：上一轮手工扫掉 24 个文件里的名字，
 * 没有留下任何东西守着，于是两份文档又把名字写了回来（一份设计 SSOT、一份 review 计划）。
 * 手工清理不留检测器等于没清——清理只作用于当时存在的文件，禁令要挡的是还没写出来的那一行。
 *
 * 两个设计约束值得写下来，因为它们都不是显然的：
 *
 * 1. **守卫自己不能拼出那个名字。** 这个文件也被 git 跟踪，一份把名字写在常量里的守卫就是
 *    它自己要挡的那种泄漏。所以这里只存 sha256 摘要：摘要不可逆，而比对只需要摘要。
 *    代价是读代码的人看不出禁的是哪个词——这正是想要的效果，需要知道的人手里有原词。
 *
 * 2. **必须按 camelCase 切分，不能只按非字母边界切。** 实测 `git grep -Iiw` 对
 *    `<Name>Browser`、`from<Name>` 这类标识符**完全失明**（新建仓库放一个 camelCase 复合词，
 *    -w 返回 exit 1），而名字进入代码的方式恰恰就是标识符。同时切分又必须窄到能放过
 *    `errorCandidates` 那种把禁词当子串包住的合法单词——按词切分能，按子串搜不能。
 */

// 只有摘要进入这个文件，原词不进。摘要在 shell 里算好后粘进来，正如上面第 1 条所述。
//
// 四个参考项目各一条。**清单必须齐**：曾经只放了两条，于是第三个名字安然躺在
// docs/reviews/ 的一份计划里，守卫全绿——一份漏项的禁令清单和没有清单几乎一样危险，
// 因为它给出的绿色是有保证感的。
//
// 反过来，AgentMux 自己的 Provider id（如 traex/traecli）**绝不能**进这个清单：它们是本仓
// 正当的产品标识，随代码发布，禁掉会让整棵树变红。判据是"这个名字属于谁"，不是"它像不像码名"。
const BANNED_TOKEN_DIGESTS = new Set([
  'e0c924608fdcda8536bd9cc86b0fce0ab2d54ecc1e8ed9673624c39cde7f7820',
  '68a32dd6b2c35412abbf319675fa086748a052cb8693e503111c32179e921d48',
  '93f518d1c534f6930590c2608eb5131e7fb02670beee97f6cf5024e19d4f5c5e',
  '78193ef266c1e3c2ce4ea2a86d7fc87e8c52799653faaac8536533a1c9300f82'
])

/**
 * MIT 许可强制保留的署名，是唯一豁免。
 *
 * 删掉这行署名会让仓库违反它所依赖代码的许可证——那比名字出现在这一个文件里严重得多。
 * 豁免精确到这一个路径：换成"凡是 .md 都放过"会把设计文档也放进来，而设计文档正是上一次
 * 漏名字的地方。
 */
const LICENSE_ATTRIBUTION_FILE = 'THIRD_PARTY_NOTICES.md'

/**
 * 这个路径是否豁免。
 *
 * 单独抽成函数，是为了让下面那条"豁免不能是类别判断"的测试有一个**可以直接质询的对象**：
 * 测试里如果自己再写一遍同样的过滤条件，放宽豁免时两边会一起放宽，测试跟着变松。
 */
function isExempt(path: string): boolean {
  return path === LICENSE_ATTRIBUTION_FILE
}

// 把标识符切成词：连续大写（`NAME` / `HTTPServer` 里的 `HTTP`）、大写开头的驼峰段、
// 小写数字段。这样 `<Name>Browser` 切出独立的名字段，而 `errorCandidates` 不会。
const WORD_SEGMENT = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 一段文本里命中禁令的词数。用于扫描，也用于自证。
 *
 * 不按词长预筛。曾经按长度预筛掉大部分词，实测只省 64ms（全仓 137ms → 73ms），但代价是
 * 往上面那个集合里加一个别的长度的摘要时，扫描会静默放行它——一个长度筛子和一份摘要清单
 * 是两处必须联动的常量，而它们必然会 drift。
 */
function bannedTokenCount(text: string): number {
  let count = 0
  for (const match of text.matchAll(WORD_SEGMENT)) {
    if (BANNED_TOKEN_DIGESTS.has(digest(match[0]!.toLowerCase()))) count += 1
  }
  return count
}

function trackedTextFiles(): { path: string; text: string }[] {
  const listing = execFileSync('git', ['ls-files', '-z'], {
    cwd: new URL('../../../', import.meta.url),
    maxBuffer: 64 * 1024 * 1024
  })
  const out: { path: string; text: string }[] = []
  for (const path of listing.toString('utf8').split('\0')) {
    if (!path) continue
    let raw: Buffer
    try {
      raw = readFileSync(new URL(`../../../${path}`, import.meta.url))
    } catch {
      continue // 跟踪但工作区里不存在（未 checkout）——没有内容可泄漏。
    }
    if (raw.includes(0)) continue // 二进制：vendored 的 ctxmux 与图标，占了 16MB 里的大头。
    out.push({ path, text: raw.toString('utf8') })
  }
  return out
}

describe('参考项目名不出现在跟踪文件里', () => {
  it('检测器看得见它要找的形状——包括 camelCase 复合词', () => {
    // 没有这条，一个瞎了的检测器会靠"什么也没找到"把下面那条禁令刷绿。
    // 这里不能把原词写进源码，所以从 THIRD_PARTY_NOTICES.md 里取——那份文件按许可证必须
    // 含有它，于是它同时是合法样本和检测器的试纸。
    const attribution = readFileSync(
      new URL(`../../../${LICENSE_ATTRIBUTION_FILE}`, import.meta.url),
      'utf8'
    )
    expect(bannedTokenCount(attribution)).toBeGreaterThan(0)

    // 从那份文件里取出真实的禁词，再合成三种形态验证切分。
    const spelled = attribution
      .match(WORD_SEGMENT)!
      .find((segment) => BANNED_TOKEN_DIGESTS.has(digest(segment.toLowerCase())))!
    const lower = spelled.toLowerCase()
    const capitalised = lower[0]!.toUpperCase() + lower.slice(1)

    expect(bannedTokenCount(lower)).toBe(1)
    expect(bannedTokenCount(lower.toUpperCase())).toBe(1)
    // 这一条是 `git grep -Iiw` 失明的形态，也是名字真正会进入代码的形态。
    expect(bannedTokenCount(`const ${capitalised}Browser = 1`)).toBe(1)
    expect(bannedTokenCount(`export const from${capitalised} = 1`)).toBe(1)

    // 而把禁词当子串包住的合法单词不能命中——按子串搜会误报，按词切分不会。
    expect(bannedTokenCount(`error${capitalised}ndidates`)).toBe(0)
    expect(bannedTokenCount(`${lower}s and ${lower}nge`)).toBe(0)
  })

  it('禁令清单的条目数是合同的一部分——少一条必须显式变红', () => {
    // 上面那条自证只能验到署名文件里真实出现的那一个词；另一个参考项目的名字今天在仓库里
    // 一次也没出现，于是"删掉它的摘要"这个变异不会让任何断言变红——实测确认过它能存活。
    // sha256 不可逆，测试无法在不拼出原词的前提下合成第二个词的样本，所以这里只能守条目数。
    // 它挡住的是"顺手删一条摘要"这种静默放宽；真要增删必须连这条断言一起改，那就是显式决定。
    expect(BANNED_TOKEN_DIGESTS.size).toBe(4)
  })

  it('扫描真的读到了整个仓库，而不是一份空清单', () => {
    // 没有这条，任何让文件遍历返回空的错误（跳过判断写反、扫描根指错、读取全失败）都会让
    // 下面的禁令靠"什么也没扫到"变绿。实测：把二进制跳过改成无条件 continue，禁令照常全绿。
    const scanned = trackedTextFiles()
    expect(scanned.length).toBeGreaterThan(400)
    const paths = new Set(scanned.map(({ path }) => path))
    expect(paths.has(LICENSE_ATTRIBUTION_FILE)).toBe(true)
    expect(paths.has('package.json')).toBe(true)
    // 曾经泄漏的那两份文档必须在扫描范围内——它们是这条守卫存在的原因。
    expect(paths.has('docs/design/agentmux-desktop-interaction.md')).toBe(true)
    expect(paths.has('docs/reviews/agentmux-provider-parity-plan.md')).toBe(true)
    // 而二进制确实被跳过了——否则 16MB 里的 vendored 二进制会拖慢每一次扫描。
    expect(paths.has('packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd')).toBe(false)
  })

  it('除了许可证强制的署名，没有任何跟踪文件提到参考项目', () => {
    const offenders = trackedTextFiles()
      .filter(({ path }) => !isExempt(path))
      .map(({ path, text }) => ({ path, count: bannedTokenCount(text) }))
      .filter(({ count }) => count > 0)
      .map(({ path, count }) => `${path}: ${count} 处`)

    expect(offenders).toEqual([])
  })

  it('豁免是一条路径相等判断，不是一个类别判断', () => {
    // 上一次漏名字的两个文件都是 .md，所以最危险的放宽方式是把豁免从"这一个路径"改成
    // "凡 .md 放过"。这条断言必须能抓住那次放宽——而"再跑一遍同样的过滤"抓不住：
    // 那样写出来的检查会跟着豁免一起放宽，两边一起变松，测试照常绿。实测确认过这一点。
    //
    // 所以判据换成：**拿一个已知含禁词的 .md 路径去问豁免函数，它必须说"不豁免"。**
    // 用真实存在的那两个曾经泄漏的文档做样本，它们今天不含禁词了，但路径依旧是 .md。
    expect(isExempt(LICENSE_ATTRIBUTION_FILE)).toBe(true)
    for (const leakedOnce of [
      'docs/design/agentmux-desktop-interaction.md',
      'docs/reviews/agentmux-provider-parity-plan.md'
    ]) {
      expect(leakedOnce.endsWith('.md')).toBe(true)
      expect(isExempt(leakedOnce)).toBe(false)
    }
  })
})
