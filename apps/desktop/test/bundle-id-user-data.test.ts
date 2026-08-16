import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// macOS bundle id 与 userData 目录名必须是同一个字符串，而它在三个文件里各手抄一份。
//
// 为什么这是「静默丢用户全部本地数据」而不是一个拼写问题：`index.ts` 把 userData 显式绑到
// `join(app.getPath('appData'), '<bundle id>')`，也就是 `~/Library/Application Support/<那个串>`。
// config、Workbench 布局、Agent Session store、崩溃日志、浏览器 profile 全落在那个目录下
// （见 config-store.ts / window-geometry-store.ts / agent-session-store-path.ts / crash-log.ts /
// browser-profile-store.ts 各自的 `getPath('userData')`）。改 plist 侧而漏改这一侧的后果不是报错，
// 是应用起来之后**看起来像全新安装**——那正是 index.ts:29-32 那段注释描述的失败模式，它当时是
// 为了消掉 dev 与 packaged 的分岔，而同一个机制反过来就是数据丢失的入口。
//
// 为什么不抽一个共享常量让三处 import：两个写入点是 `scripts/*.mjs`（打包与 dev 分支脚本），
// 它们导不了 `src/` 里的 TS 常量——本仓 scripts 目录里**没有任何** `from '../src/'` 的先例，
// 而 tsc 也根本看不见 `.mjs`。这是本仓「构建图之外的手抄常量」那一类：SSOT 在这里不可达，
// 所以守卫是唯一的收口手段。
//
// 判据因此按「**谁写那个字符串**」取值，不枚举文件、不数出现次数：每个写入点各自被解析出它实际
// 写下的那个值，再要求这些值互相相等。加第四个写入点时这条不会自动覆盖它——那是枚举法固有的
// 局限，所以下面另有一条反向断言：全仓出现这个串的位置必须都在已知集合里，出现在别处就红。

const DESKTOP = new URL('../', import.meta.url)

function read(relative: string): string {
  return readFileSync(new URL(relative, DESKTOP), 'utf8')
}

/** 打包脚本写进 Info.plist 的那个值。取常量声明本身，不取它的使用点。 */
function packagedBundleId(): string | null {
  const match = /^const BUNDLE_ID = '([^']+)'/m.exec(read('scripts/package-macos.mjs'))
  return match ? match[1] : null
}

/** dev 分支脚本用 plutil 写进 CFBundleIdentifier 的那个字面量。 */
function devBundleId(): string | null {
  const match = /'-replace',\s*'CFBundleIdentifier',\s*'-string',\s*'([^']+)'/.exec(
    read('scripts/dev-desktop.mjs')
  )
  return match ? match[1] : null
}

/** 主进程用来拼 userData 路径的那个目录名。 */
function userDataDirectoryName(): string | null {
  const match = /getPath\('appData'\),\s*'([^']+)'\)/.exec(read('src/main/index.ts'))
  return match ? match[1] : null
}

describe('bundle id 与 userData 目录名是同一个串', () => {
  it('三个写入点各自都取得出一个值——正则失配必须红而不是静默变恒真', () => {
    // 自检。这三个函数是文本解析，重构掉它们锚定的形状（改成模板串、抽成变量、换引号）会让
    // 匹配返回 null；若不在这里响亮失败，下面那条相等断言就会退化成 null === null 恒真。
    expect(packagedBundleId(), 'package-macos.mjs 的 BUNDLE_ID 常量声明没解析出来').not.toBeNull()
    expect(devBundleId(), 'dev-desktop.mjs 的 CFBundleIdentifier 写入没解析出来').not.toBeNull()
    expect(userDataDirectoryName(), 'index.ts 的 userData 目录名没解析出来').not.toBeNull()
  })

  it('打包写进 plist 的 id 与主进程拿来当 userData 目录名的串逐字相等', () => {
    // 这一对是真正的数据丢失面：签名包的 bundle id 变了而 userData 目录名没跟上（或反过来），
    // 用户升级后打开的是一个空目录，全部项目、会话、布局、偏好都还在盘上但应用再也找不到。
    expect(userDataDirectoryName()).toBe(packagedBundleId())
  })

  it('dev 分支与打包分支写同一个 id——否则两种模式各持一份用户数据', () => {
    // index.ts:29-32 那段注释说的就是这件事：dev 与 packaged 必须落在同一个 durable 根上，
    // 分岔的症状是「重启看起来像全新安装」。dev 脚本改了 id 而打包脚本没改时，
    // 开发模式下看到的数据与真实安装的数据是两套。
    expect(devBundleId()).toBe(packagedBundleId())
  })

  it('这个串只出现在已知的写入点与文档里——冒出第四个手抄点必须红', () => {
    // 上面三条是枚举法，天然覆盖不到新增的第四个写入点。这条从反方向收口。
    //
    // 关键在于**扫的范围必须是全仓，而不是已知清单本身**：只在清单里的文件中查找，就永远发现不了
    // 清单外的新手抄点——那恰好是这条断言声称要防的事（本仓「禁止形状不在场的守卫既漏又误伤」）。
    // 所以这里走 `git grep`，让 git 决定有哪些文件，我们只负责判「找到的位置是否都已知」。
    const literal = packagedBundleId()
    expect(literal, '没有 SSOT 可扫').not.toBeNull()

    // `--untracked` 不是可选的：默认的 `git grep` 只搜**已跟踪**文件，于是新写一个脚本、在
    // `git add` 之前跑这道门，第四个手抄点会被静默放过——实测过一次（新建一个 .mjs 抄一份 id，
    // 4 条全绿）。而那恰好是最可能发生的时序：作者写完新脚本、跑测试、然后才提交。
    const grep = spawnSync(
      'git',
      ['grep', '-l', '--untracked', '--fixed-strings', literal!, '--', ':!*pnpm-lock*', ':!*/dist/*'],
      { cwd: fileURLToPath(new URL('../../', DESKTOP)), encoding: 'utf8' }
    )
    // 自检：grep 必须真的跑起来并至少找到那三个写入点。它静默失败（git 不在、cwd 不对、
    // pathspec 写错）时返回空清单，下面的「全部已知」就会退化成恒真。
    expect(grep.error, `git grep 没跑起来：${grep.error?.message}`).toBeUndefined()
    const hits = grep.stdout.split('\n').filter((line) => line.length > 0)
    expect(hits.length, 'git grep 一个位置都没找到——扫描范围写错了').toBeGreaterThanOrEqual(3)

    // 例外项各自带着它为什么无害的理由，而不是一个笼统的白名单。
    // 注意本测试文件**不在**清单里，因为它刻意不硬抄那个串（`literal` 从打包侧 SSOT 解析而来）。
    // 哪天有人在这里手抄一份，这条会红——那是对的：守卫自己抄一份就失去了判定能力。
    const known = new Map<string, string>([
      ['apps/desktop/scripts/package-macos.mjs', '打包侧 SSOT（BUNDLE_ID 常量，其余用处都取它）'],
      ['apps/desktop/scripts/dev-desktop.mjs', 'dev 分支脚本的 plutil 写入'],
      ['apps/desktop/src/main/index.ts', 'userData 目录名'],
      ['apps/desktop/scripts/probe-file-editing.mjs', '注释：说明探针刻意不用这个真实目录'],
      ['docs/plans/agentmux-desktop-package.md', '文档描述，不参与构建'],
      // 下面两处是**注释里的证据引用**，不是写入点：98f5bf96 修「存量 v9 配置缺 saveBookmark
      // 就加载不了」时，举证依据正是本机那份真实配置的所在目录，注释里点名它才说得清这不是
      // 假想缺陷。没有任何代码读这两处，改掉它们也不会让任何一份用户数据换位置。
      ['apps/desktop/src/main/config-store.ts', '注释：举证那份缺键的真实 v9 配置在哪'],
      ['apps/desktop/test/config-store.test.ts', '注释：同上，回归用例的出处说明']
    ])

    const unexpected = hits.filter((path) => !known.has(path))
    expect(
      unexpected,
      `bundle id 出现在未登记的位置：${unexpected.join(', ')}——它是不是也该参与上面的相等判定？`
    ).toEqual([])

    // 反向：已知清单里的每一项都必须真的还含有这个串。陈旧的例外项是死代码，
    // 会让读表的人以为某个文件被这条守着，而它早就不写这个串了。
    for (const [path, why] of known) {
      expect(hits, `${path} 不再含有 bundle id（例外理由已过时：${why}）`).toContain(path)
    }
  })

  it('扫描确实覆盖未跟踪文件——删掉 --untracked 会让上一条重新失明', () => {
    // 上一条的正确性完全架在 `--untracked` 上，而那是一个容易被「优化」掉的 flag：删掉它测试照旧
    // 全绿（未跟踪的手抄点不在扫描范围里，看起来就是「没有多余手抄」）。所以这里用一个真的未跟踪
    // 临时文件做对照实验，直接质询扫描范围本身，而不是相信那个 flag 还在。
    //
    // 本仓「守卫要判可达性不是在场」的同一道理：判据不是「命令行里有 --untracked 这个词」，
    // 而是「一个未跟踪文件里的串真的会被找到」。
    const literal = packagedBundleId()
    expect(literal).not.toBeNull()
    const repoRoot = fileURLToPath(new URL('../../', DESKTOP))
    const probe = join(repoRoot, `.bundle-id-scan-probe-${process.pid}.txt`)
    writeFileSync(probe, `${literal}\n`)
    try {
      const grep = spawnSync(
        'git',
        ['grep', '-l', '--untracked', '--fixed-strings', literal!, '--', ':!*pnpm-lock*', ':!*/dist/*'],
        { cwd: repoRoot, encoding: 'utf8' }
      )
      const hits = grep.stdout.split('\n').filter((line) => line.length > 0)
      expect(
        hits.some((path) => path.includes('.bundle-id-scan-probe-')),
        '未跟踪文件里的 bundle id 没被扫到——上一条守卫对「提交前新增的手抄点」是失明的'
      ).toBe(true)
    } finally {
      rmSync(probe, { force: true })
    }
  })
})
