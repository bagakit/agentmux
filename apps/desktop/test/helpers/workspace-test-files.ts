import { globSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 元守卫的扫描面：全部 workspace 包的 test 树。
 *
 * 两道元守卫（`vacuous-on-empty-predicate`、`sliced-scan-surface-not-empty`）守的是全仓的测试代码，
 * 而它们此前都写着 `readdirSync(new URL('../test/', import.meta.url))`——非递归、且只有 `apps/desktop`
 * 这一个包。`packages/core/test` 的 138 个文件（含 `test/providers/`、`test/helpers/` 两个子目录）
 * 从来没被它们看过，那里有活的违例。这正是本仓记过的「守卫只数了一族里的一个成员」：少数派场景
 * 计数恒 0，守卫静默失效，而多数派在场时总数仍然好看，于是没有任何东西会响。
 *
 * 所以扫描根**派生**自 `pnpm-workspace.yaml`——那是「这个仓库由哪些包组成」在本仓的唯一权威。
 * 手抄一份包名清单会和来源一起漂移（新包不在清单里、清单里的包被删），而漂移时清单自己不会响；
 * 派生则是新增一个包、或在 test/ 下开一个子目录，守卫自动跟上，不需要有人记得回来改。
 *
 * 两道守卫共用这一处而不是各抄一份：两份会漂移，而漂移时谁都不会响——那正是这两道守卫在防的
 * 那一类缺陷，不能在修它的过程中再造一个。
 */

/** `apps/desktop/test/helpers/` 往上四层就是仓根。 */
const REPO_ROOT = new URL('../../../../', import.meta.url)

/**
 * `pnpm-workspace.yaml` 里 `packages:` 那个序列，原样返回（`packages/*`、`apps/*`）。
 *
 * 只读这一个块，用的是它在本仓的实际形状：顶格的 `packages:`，后面跟若干 `  - <glob>` 行，
 * 到下一个顶格 key 为止。不引 yaml 解析器——`apps/desktop` 没有这个依赖，为读一个平坦的字符串
 * 序列而往 package.json 里加一条 devDep（并动 lockfile）不划算。
 *
 * 形状哪天变了（流式 `packages: [a, b]`、嵌套、改名），这里会读出空数组，而调用方
 * {@link workspaceTestFiles} 的使用者必须断言扫描面非空——于是变化会以「扫描面空了」的形式
 * 当场变红，而不是静默退化成「一个包都不扫」。
 */
function workspacePackageGlobs(): string[] {
  const text = readFileSync(new URL('pnpm-workspace.yaml', REPO_ROOT), 'utf8')
  const globs: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inside = true
      continue
    }
    if (!inside) continue
    const item = /^\s+-\s*(.+?)\s*$/.exec(line)
    if (item) {
      globs.push(item[1]!.replace(/^['"]|['"]$/g, ''))
      continue
    }
    if (line.trim() === '') continue
    break // 下一个顶格 key，`packages:` 块到此为止
  }
  return globs
}

export interface WorkspaceTestFile {
  /** 相对仓根，用于报错信息（`packages/core/test/providers/kimi.test.ts`）。 */
  readonly relPath: string
  readonly absPath: string
  /** 这个文件所在目录的 URL（带尾斜杠），文件内 `'../src/…'` 之类相对路径的解析基址。 */
  readonly dirUrl: URL
}

/**
 * 全部 workspace 包 `test/` 树下的 `.ts` / `.tsx`，递归。
 *
 * 排序只为让报错顺序稳定。仓库内部的嵌套工作树（`.claude/worktrees/`、`.worktrees/`）天然不在
 * `packages/*` / `apps/*` 之下，glob 锚在仓根，够不着它们——不需要额外排除。
 */
export function workspaceTestFiles(): WorkspaceTestFile[] {
  const root = fileURLToPath(REPO_ROOT)
  const patterns = workspacePackageGlobs().flatMap((pkg) => [
    `${pkg}/test/**/*.ts`,
    `${pkg}/test/**/*.tsx`
  ])
  const relPaths = [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd: root })))].sort()
  return relPaths.map((relPath) => {
    const absPath = `${root}${relPath}`
    return { relPath, absPath, dirUrl: pathToFileURL(`${dirname(absPath)}/`) }
  })
}

/**
 * 独立见证：直接从磁盘找「深度 2 的包目录下有 test 树」的包，不经过 workspace 声明。
 *
 * 这是给扫描面自检用的第二个来源。只断言「扫到的文件数 > N」挡不住**丢掉一整个包**：
 * `apps/desktop` 一家就有 596 个文件，把 `packages/*` 从声明里删掉，总数仍然过任何合理阈值。
 * 而两个独立来源只在缺陷处分岔——声明里少了一个包，磁盘上那个包的 test 树还在，当场对不上。
 */
export function packageRootsWithTestsOnDisk(): string[] {
  const root = fileURLToPath(REPO_ROOT)
  const hits = ['*/*/test/**/*.ts', '*/*/test/**/*.tsx'].flatMap((pattern) =>
    globSync(pattern, { cwd: root, exclude: (name) => name === 'node_modules' })
  )
  return [...new Set(hits.map((relPath) => relPath.slice(0, relPath.indexOf('/test/'))))].sort()
}
