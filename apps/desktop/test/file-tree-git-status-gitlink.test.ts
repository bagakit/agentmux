import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseGitStatusPorcelain } from '../src/main/git-service.js'
import { buildFileTreeGitStatusIndex } from '../src/renderer/src/lib/file-tree-git-status.js'

/**
 * 守的缺陷（#749）：**脏的 submodule 在文件树里显示为 clean**。
 *
 * git 报告一个改动过的 submodule 时给的是 gitlink 本身那一条（` M sub`），**没有尾斜杠**——它命名的是
 * 那个链接，不是链接里面的某个路径，所以这条改动没有任何后代条目。而文件树是 `readdir` 出来的，
 * submodule 的 checkout 在盘上是个真目录，于是渲染层用 `isDirectory: true` 去查它。旧实现把每条改动
 * 的自身路径只记进 fileStatus、只把**祖先**记进 dirStatus，于是这一条两头都落空：目录表里没有
 * `sub`（它自己不是谁的祖先），文件表里有但没人按文件查。用户看到的就是「submodule 明明脏着，树里
 * 一点标记都没有」，而 Changes 面板同时正确列着它。
 *
 * 反方向的不对称同样无法在这个函数里猜出来：未跟踪的嵌套仓库来的是 `?? strayrepo/`，**带**尾斜杠且
 * 同样没有后代条目。所以修法不是「按尾斜杠判类型」——那是把树已经掌握的事实在这里重抄一份（记忆
 * two-resolutions-that-happen-to-agree）——而是把改动的**自身**路径同时记进两张表，让查询变成全域的。
 *
 * ---
 * 前提全部由**真 git** 生成，不由手写的 porcelain 串生成。理由：这条缺陷的整个前提就是「git 到底吐
 * 什么形状」——尾斜杠在哪一类上出现、gitlink 有没有后代条目。用声明拼出来的 fixture 会让我把自己的
 * 假设当成证据（记忆 synthesized-fixture-is-self-certification：改坏 marker、对调帧边界都能在全绿下
 * 存活）。所以每条用例的输入都是在临时目录里真跑 `git status --porcelain=v1 -z` 拿到的字节，经生产的
 * `parseGitStatusPorcelain` 解析后喂给被测的索引。
 *
 * 这个文件**不**守什么：它不守 FileExplorer 有没有把 `node.isDirectory` 传进 `get`（那是接线，由
 * file-explorer 侧的判据管），也不守 porcelain 解析本身（git-service 侧另有覆盖）。
 */

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args],
    { cwd, env: GIT_ENV, encoding: 'utf8' }
  )
}

/** 真跑一次生产用的 porcelain 命令，并按生产的解析器还原成 GitFileChange。 */
function statusOf(repo: string) {
  const raw = git(repo, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all')
  return parseGitStatusPorcelain(raw)
}

let root: string
let outer: string
let dirtySubmodulePorcelain: string
let untrackedNestedRepoPorcelain: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'am-gitlink-'))
  const inner = join(root, 'inner')
  outer = join(root, 'outer')

  mkdirSync(inner)
  git(inner, 'init', '-q')
  writeFileSync(join(inner, 'a.txt'), 'one\n')
  git(inner, 'add', '.')
  git(inner, 'commit', '-qm', 'init')

  mkdirSync(outer)
  git(outer, 'init', '-q')
  writeFileSync(join(outer, 'base.txt'), 'base\n')
  git(outer, 'add', '.')
  git(outer, 'commit', '-qm', 'init')
  // 一个顶层 submodule 和一个嵌一层的，后者用来证祖先也要着色。
  git(outer, 'submodule', 'add', '-q', inner, 'sub')
  git(outer, 'submodule', 'add', '-q', inner, 'vendor/nested')
  git(outer, 'commit', '-qm', 'add submodules')

  // 让两个 submodule 都脏（改它们工作区里的文件，不碰外层）。
  appendFileSync(join(outer, 'sub', 'a.txt'), 'dirty\n')
  appendFileSync(join(outer, 'vendor', 'nested', 'a.txt'), 'dirty\n')
  // 一个未跟踪的嵌套仓库：git 对它给的是带尾斜杠的一条，且同样没有后代条目。
  const stray = join(outer, 'strayrepo')
  mkdirSync(stray)
  git(stray, 'init', '-q')
  writeFileSync(join(stray, 'f.txt'), 'x\n')

  dirtySubmodulePorcelain = git(outer, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  untrackedNestedRepoPorcelain = dirtySubmodulePorcelain
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 严格更深的条目：路径在 `<node>/` 之下，且不是那个节点自己（尾斜杠形让它会匹配自身）。 */
function descendantsOf(changes: readonly { path: string }[], node: string): string[] {
  return changes
    .map((change) => change.path)
    .filter((path) => path.startsWith(`${node}/`) && path.replace(/\/+$/, '') !== node)
}

describe('真 git 给出的 gitlink 形状（前提自检，不是断言被测代码）', () => {
  it('脏 submodule 是一条自身路径、无尾斜杠、无后代条目', () => {
    // 这条不测我们的代码，它把缺陷的前提钉成断言：哪天 git 改了这个形状（或者我把前提记错了），
    // 红在这里，而不是让下面几条在错误前提上继续绿。
    const { changes } = parseGitStatusPorcelain(dirtySubmodulePorcelain)
    const gitlink = changes.find((change) => change.path === 'sub')
    expect(gitlink, `git 没有报告 sub 这条改动，porcelain 原样：${JSON.stringify(dirtySubmodulePorcelain)}`)
      .toBeDefined()
    expect(gitlink!.path.endsWith('/'), 'gitlink 那条不该带尾斜杠').toBe(false)
    expect(descendantsOf(changes, 'sub'), 'gitlink 不该有后代条目').toEqual([])
    expect(gitlink!.untracked).toBe(false)
  })

  it('未跟踪的嵌套仓库是一条自身路径、**带**尾斜杠、同样无后代条目', () => {
    // 与上一条成对：两个方向的尾斜杠正好相反，这就是「按尾斜杠猜类型」不成立的原因。
    const { changes } = parseGitStatusPorcelain(untrackedNestedRepoPorcelain)
    const stray = changes.find((change) => change.path.replace(/\/+$/, '') === 'strayrepo')
    expect(stray, `git 没有报告 strayrepo，porcelain 原样：${JSON.stringify(untrackedNestedRepoPorcelain)}`)
      .toBeDefined()
    expect(stray!.path.endsWith('/'), '未跟踪嵌套仓库那条该带尾斜杠').toBe(true)
    expect(descendantsOf(changes, 'strayrepo'), '它也不该有后代条目').toEqual([])
  })

  it('两类的尾斜杠确实相反——判据不是恒真的', () => {
    // 没有这条，上面两条可能同时被「git 其实两边都带斜杠」这种世界满足。
    const { changes } = parseGitStatusPorcelain(dirtySubmodulePorcelain)
    const gitlink = changes.find((change) => change.path === 'sub')!
    const stray = changes.find((change) => change.path.replace(/\/+$/, '') === 'strayrepo')!
    expect(gitlink.path.endsWith('/')).not.toBe(stray.path.endsWith('/'))
  })
})

describe('索引对 gitlink 与无叶子路径的查询是全域的（#749）', () => {
  it('脏 submodule 按目录查得到状态——这是 #749 本身', () => {
    // 树里 sub 是 readdir 出来的真目录，所以渲染层一定用 isDirectory: true 来查。
    const { changes } = parseGitStatusPorcelain(dirtySubmodulePorcelain)
    const index = buildFileTreeGitStatusIndex(changes)
    expect(index.get('sub', true), '脏 submodule 在树里显示为 clean').not.toBeNull()
  })

  it('嵌一层的脏 submodule 自己和它的祖先目录都着色', () => {
    // vendor/nested 是 gitlink 自身（要靠新增的自身记录），vendor 是它的祖先（靠原有的祖先循环）。
    // 两个键各判一次：只修好一侧的实现会在这里露出来。
    const { changes } = parseGitStatusPorcelain(dirtySubmodulePorcelain)
    const index = buildFileTreeGitStatusIndex(changes)
    expect(index.get('vendor/nested', true), 'gitlink 自身没着色').not.toBeNull()
    expect(index.get('vendor', true), 'gitlink 的祖先目录没着色').not.toBeNull()
  })

  it('未跟踪的嵌套仓库按目录查得到，且尾斜杠被归一掉了', () => {
    // 树的路径永远不带尾斜杠，所以 `?? strayrepo/` 必须以 `strayrepo` 入表；不归一的话这条永查不到。
    const { changes } = parseGitStatusPorcelain(untrackedNestedRepoPorcelain)
    const index = buildFileTreeGitStatusIndex(changes)
    expect(index.get('strayrepo', true), '未跟踪的嵌套仓库目录没着色').toBe('untracked')
    expect(index.get('strayrepo/', true), '带尾斜杠的键不该被留在表里').toBeNull()
  })

  it('同一条改动按文件查也拿得到——两种 kind 都覆盖，不是把一侧换成另一侧', () => {
    // 修法是「自身路径同时进两张表」。如果实现被改成「只进 dirStatus」，普通文件的着色会整片消失，
    // 而上面那些用例一条都不会红。这条钉住那一侧。
    const { changes } = parseGitStatusPorcelain(dirtySubmodulePorcelain)
    const index = buildFileTreeGitStatusIndex(changes)
    expect(index.get('sub', false), 'gitlink 按文件查也该拿到（porcelain 没说它是哪一类）').not.toBeNull()
    expect(index.get('strayrepo', false)).toBe('untracked')
  })

  it('干净的兄弟节点仍然是 null——自身双记不是把整棵树染色', () => {
    // 反向自证：把自身路径也记进 dirStatus 之后，必须有人证明它没有顺手把无关节点也标上。
    const { changes } = parseGitStatusPorcelain(dirtySubmodulePorcelain)
    const index = buildFileTreeGitStatusIndex(changes)
    expect(index.get('base.txt', false)).toBeNull()
    expect(index.get('nosuchdir', true)).toBeNull()
    // vendor 之所以有色是因为它是脏 gitlink 的祖先；它的兄弟没有理由有色。
    expect(index.get('sub/a.txt', false), '树里根本看不到 submodule 内部的文件').toBeNull()
  })
})
