import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CTXMUX_COMMIT, CTXMUX_VERSION } from '../src/ctxmux-run-adapter.js'

// ---------------------------------------------------------------------------
// 「运行时上报的 CtxMux 版本/commit 必须绑定到 SHA 校验过的那份原件」的接线守护（F2）。
//
// 由来：`client.ts` 的 `runtimeDiagnostics`（ctxmux.version / ctxmux.sourceCommit）与
// `terminalEnvironment`（TERM_PROGRAM_VERSION）、以及 `ctxmux-run-adapter.ts` 的 daemonEnvironment
// 曾各自**手抄**一份 '0.1.0' / 40 位 commit 字面量。可信原件是 `ctxmux-run-adapter.ts` 里的
// `CTXMUX_VERSION` / `CTXMUX_COMMIT`（以及 `runtime-paths.ts` 的 `CTXMUX_MANIFEST_SHA256`）——那些
// 模块在 load 时拿它们对着 SHA 校验过的 vendored manifest.json 断言（verifyArtifacts：
// manifest.source.commit===CTXMUX_COMMIT、manifest.product.version===CTXMUX_VERSION，由
// CTXMUX_MANIFEST_SHA256 兜底）。手抄的那几处一旦 vendored artifact 被 bump 就静默漂移，
// doctor/about 面自信地报错版本，且**没有编译错误**。
//
// 本文件有两道独立的守护：
//
// 【第一道 · 接线判据（结构性 / import 关系，非名字计数）】
//   为什么判据必须是结构性的（AST），不能只写 `version === CTXMUX_VERSION` 这种行为断言：今天两边
//   的取值恰好相等，所以一份**新手抄**的字面量 `'0.1.0'` 对行为断言完全透明（本仓反复踩到的「等价性
//   抓不到新手抄的一份」）。承重的是「那个属性值就是 import 进来的那个标识符」，只有 parser 看得见。
//   判据：逐个消费点的属性值节点必须是**指定的那个已导入标识符**（`CTXMUX_VERSION` / `CTXMUX_COMMIT`），
//   不是字符串字面量、也不是别的名字。杀死的变异：把任一处改回 `'0.1.0'` / `'c13ab1…'`（StringLiteral
//   初始化器 → 立刻红），或引到错误的常量（Identifier 文本不符 → 红）。
//
// 【第二道 · 覆盖面派生（不信任任何手写清单）】
//   一张手写的 BINDING_SITES 文件名清单本身就是一张没人守的白名单：别处新增一份手抄它看不见。所以
//   第二道不枚举「该绑定的文件」，而是**派生**出「凡是提到某个 CtxMux 身份字面量的 tracked 文件」这个
//   集合（用 git 在工作树里搜三个可区分的哈希 + 两种版本串形态），再断言这个集合恰好等于一张**带角色**
//   的分类表，且每个角色的**结构前提**在文件里成立。新增一处手抄 → 集合多出一个未分类成员 → 红。
//   自检：派生器必须能看见一个已知成员（SSOT adapter 文件）且集合非空；若扫描根写错返回空集，断言必红
//   而不是空过——这个坑本仓反复踩到。
//
// 本守卫**看不见 / 不保证**什么（明确写出，避免变成日后的假承诺）：
//   1. 它不执行代码，不证明 `CTXMUX_VERSION` 自身的取值对——那由 ctxmux-run-adapter 的 manifest 断言
//      与打包端到端契约（reliability-stress-worker 断言 sourceCommit、package-macos.mjs 从 manifest 派生）
//      负责。第一道只证明「消费点绑到了同一个已验证源」，第二道只证明「没有未分类的手抄游离在外」。
//   2. 「可区分身份字面量」集合 = {commit 哈希、tree 哈希、manifest sha256、两种组合版本串
//      (`ctxmuxd? X.Y.Z (protocol N)`、`CtxMux X.Y.Z · protocol N`)}。一份**只**写
//      `version: '0.1.0'` / `protocol: 14` 这类**非**可区分字段（不带任何哈希、也不带组合串）的新手抄
//      不在雷达上——'0.1.0' 也是 app 自身版本号，纳入会噪声爆炸。
//   3. 扫描面 = tracked 的 `*.ts` / `*.mjs` / `*.json`，排除 dist/node_modules/vendor/.tmp/.bagakit。
//      `.md`（README.md、docs/** 里也写了 commit）**不在**扫描面内，那里的漂移抓不到。
//      vendored manifest.json 是**原件**（ground truth）不是副本，被 vendor/ 排除规则剔除。
//   4. `manifest-verifier` 角色的字面量是**自校验**的（该文件自己读 manifest.json 并对着某个 manifest
//      字段断言），所以本守卫只验证它「确实读了 manifest 且比了字段」这个结构前提，**不**把它的字面量
//      跟 SSOT 做等值比对。`anchor` 角色（test/ 下的期望值 fixture）是**故意独立**的历史锚点——本仓
//      「期望值不能由被测对象算出」要求它们写死历史字面量，因此本守卫也**不**拿它们跟 SSOT 比对，只
//      保证它们已被分类登记。
//   5. `api.ts` 的 dev-mock（'CtxMux 0.1.0 · protocol 14'）**没有**绑定到 SSOT：core 没有任何 node-free
//      的导出携带 CtxMux 身份（ctxmux-run-adapter / runtime-paths 都 import 了 node:*，进不了浏览器
//      bundle），而这串是 web 预览里的诚实虚构（浏览器里根本没有 daemon）。它**能**静默漂移；第二道
//      只保证它是 renderer 里**唯一**那处身份字面量（renderer 内新增第二处 → 红）。
//   6. 本守卫文件自身也在派生集合里（角色 `guard`）：为了搜别处的手抄，它必须把三个可区分哈希写进
//      `IDENTITY_HASHES`，于是 git grep 也命中它。这是刻意的、可核的自命中，不是遗漏。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = join(here, '..')
const repoRoot = join(coreRoot, '..', '..')
const clientPath = join(coreRoot, 'src', 'client.ts')
const adapterPath = join(coreRoot, 'src', 'ctxmux-run-adapter.ts')

const ADAPTER_MODULE_SPECIFIER = './ctxmux-run-adapter.js'

/** 每个消费点：文件、属性键、期望绑定到的已导入标识符。枚举而非过滤——过滤会让删掉一处的文件自己退出判据。 */
const BINDING_SITES = [
  { path: clientPath, key: 'version', expected: 'CTXMUX_VERSION' },
  { path: clientPath, key: 'sourceCommit', expected: 'CTXMUX_COMMIT' },
  { path: clientPath, key: 'TERM_PROGRAM_VERSION', expected: 'CTXMUX_VERSION' },
  { path: adapterPath, key: 'TERM_PROGRAM_VERSION', expected: 'CTXMUX_VERSION' }
] as const

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/**
 * 一个源码里，属性键为 `key` 的所有 PropertyAssignment 的初始化器节点。返回节点本身，让调用方去判
 * 「是不是那个标识符」。刻意收集**全部**同名键：若某处被改回字面量，它照样在集合里、照样被质询，
 * 而不是被过滤掉。
 */
function propertyValues(sourceFile: ts.SourceFile, key: string): ts.Expression[] {
  const values: ts.Expression[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === key
    ) {
      values.push(node.initializer)
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return values
}

/** 判定：一个初始化器节点是否恰好是名为 `name` 的裸标识符引用（不是字符串、不是成员访问、不是调用）。 */
function isIdentifierReference(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name
}

/** 一个模块从 `specifier` 具名导入的标识符集合（用于证明 client.ts 真的从 adapter 引了这两个常量）。 */
function namedImportsFrom(sourceFile: ts.SourceFile, specifier: string): Set<string> {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue
    const clause = statement.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) names.add(element.name.text)
    }
  }
  return names
}

// --- 第二道：覆盖面派生所需的常量与提取器 -------------------------------------

/**
 * 可区分的身份哈希：commit / tree / manifest-sha256。每个都长到不会误命中别的东西。
 *
 * **这里必须是当前 vendored artifact 的三个值。** 派生器靠它们搜出「还有谁手抄了身份字面量」——
 * 留着上一代的值，搜到的就是一张过期的地图：新 artifact 的手抄一份都看不见，而 anchor 角色那些
 * **故意**写死历史值的 test fixture 会继续命中，于是清单看起来还是满的、判据却已经全空。
 * bump artifact 时这三个值跟着 `CTXMUX_COMMIT` / `CTXMUX_TREE` / `CTXMUX_MANIFEST_SHA256` 一起改。
 */
const IDENTITY_HASHES = [
  'c168c0ab9cd849bfade68461b62684982c71f688',
  'a2cc33fe7adac2b25110df58370e3dac17850e00',
  '1dfe2c94d089a5ba4248c34abbeccbc61300e59308bcb6c3e96967503fee4711'
] as const

/**
 * 两种「组合版本串」形态。api.ts 的预览串只由这里命中（它不含任何哈希）。
 *
 * protocol 号后面是 `[,)]` 而不是 `\)`：ctxmuxd 从 protocol 17 起在同一对括号里追加
 * `, handoff <schema>`（升级目标必须能自报它接受的 handoff schema，否则 exec 前会被拒），
 * 而 ctxmux CLI 仍然只印到 protocol。钉死 `\)` 会让这个派生器**漏掉** ctxmuxd 的那一族手抄，
 * 而漏掉不会报错——它只会让清单看起来是满的。
 */
const IDENTITY_VERSION_STRING_PATTERNS = [
  'ctxmuxd? [0-9]+\\.[0-9]+\\.[0-9]+ \\(protocol [0-9]+[,)]',
  'CtxMux [0-9]+\\.[0-9]+\\.[0-9]+ · protocol [0-9]+'
] as const

/** 扫描面：tracked 的这三类文件，排除产物/依赖/原件目录。写全相对 pathspec（裸词会失效）。 */
const SCAN_PATHSPECS = [
  '*.ts',
  '*.mjs',
  '*.json',
  ':!**/dist/**',
  ':!**/node_modules/**',
  ':!**/vendor/**',
  ':!.tmp/**',
  ':!.bagakit/**'
] as const

/**
 * 派生器：在工作树里搜出「提到任一可区分身份字面量」的 tracked 文件（repo 相对路径）。
 * 用 `git grep`（看工作树，故能看见未提交的改动与本文件新增）；哈希用定长匹配，版本串用扩展正则。
 * `git grep` 无命中时退出码为 1——那不是错误，返回空数组；只有 git 本身跑不起来才会抛，届时下面的
 * 「已知成员在场 / 集合非空」自检会响亮变红，而不是空过。
 */
function identityMentioningFiles(): string[] {
  const found = new Set<string>()
  const runGrep = (args: string[]): string[] => {
    try {
      const out = execFileSync('git', ['grep', ...args, '--', ...SCAN_PATHSPECS], {
        cwd: repoRoot,
        encoding: 'utf8'
      })
      return out.split('\n').map((line) => line.trim()).filter(Boolean)
    } catch (error) {
      // 退出码 1 = 无命中；stdout 为空即可当空集。其它退出码（git 缺失/仓库异常）继续抛。
      const status = (error as { status?: number }).status
      const stdout = String((error as { stdout?: unknown }).stdout ?? '')
      if (status === 1 && stdout.trim() === '') return []
      throw error
    }
  }
  for (const hash of IDENTITY_HASHES) {
    for (const path of runGrep(['-l', '-F', hash])) found.add(path)
  }
  for (const pattern of IDENTITY_VERSION_STRING_PATTERNS) {
    for (const path of runGrep(['-l', '-E', pattern])) found.add(path)
  }
  return [...found].sort()
}

/**
 * 分类表：凡是提到身份字面量的 tracked 文件，都必须在这里被点名并归入一个角色。
 * 这不是「该绑定的白名单」，而是「派生集合 === 这张表」的对账基准；派生集合多一个/少一个都红。
 * 角色语义见文件头「本守卫看不见什么」第 4、5 条。
 *
 * bump artifact 时这张表会**两头动**：手抄当前身份的文件要跟着新值改（否则漂移），而那些写死了
 * **上一代**字面量的纯 fixture 会就此掉出派生集合、要从表里删掉。后者不是遗漏——判据是「谁提到了
 * 当前身份」，一个拿旧 SHA 当占位符的合成 fixture 本来就不在这个问题域里（`doctor.test.ts` 那两个
 * 就是：它们的 `protocolVersion: 12` 从来没对应过任何真实 artifact）。
 */
const IDENTITY_ROLES: Record<string, 'ssot' | 'manifest-verifier' | 'anchor' | 'preview-mock' | 'guard'> = {
  'packages/core/test/ctxmux-version-binding.test.ts': 'guard',
  'packages/core/src/ctxmux-run-adapter.ts': 'ssot',
  'packages/core/src/runtime-paths.ts': 'ssot',
  'packages/core/scripts/build.mjs': 'manifest-verifier',
  'packages/core/scripts/run-daemon-cutover-benchmark.mjs': 'manifest-verifier',
  'packages/core/test/package-consumer.integration.test.ts': 'manifest-verifier',
  'packages/core/test/daemon-cutover-benchmark.test.ts': 'anchor',
  'packages/core/test/reliability-stress.integration.test.ts': 'anchor',
  'packages/core/test/fixtures/reliability-budgets.json': 'anchor',
  'packages/core/test/runtime-paths.test.ts': 'anchor',
  'apps/desktop/src/renderer/src/lib/api.ts': 'preview-mock'
}

/** 每个角色的结构前提。返回 null 表示前提成立，否则返回失败原因（用于响亮断言）。 */
function roleViolation(relPath: string, role: string): string | null {
  const abs = join(repoRoot, relPath)
  const text = readFileSync(abs, 'utf8')
  switch (role) {
    case 'ssot': {
      // 原件文件里必须**导出** identity 常量声明（不是别处引来的同名符号）。
      const exportsAnIdentity = /export const CTXMUX_(COMMIT|VERSION|MANIFEST_SHA256)\s*=/.test(text)
      return exportsAnIdentity ? null : `${relPath} 声明为 ssot 却没有 \`export const CTXMUX_*\` 声明`
    }
    case 'manifest-verifier': {
      // 自校验前提：读 manifest.json，且拿某个 manifest 字段（或 CTXMUX_ARTIFACT 冻结体）作比对。
      const readsManifest = text.includes('manifest.json')
      const comparesField =
        /manifest\.(source|product)\.(commit|tree|version|protocol)/.test(text) ||
        /artifactManifest\.source/.test(text) ||
        /CTXMUX_ARTIFACT\.(commit|tree|version|protocol|manifestSha256)/.test(text)
      return readsManifest && comparesField
        ? null
        : `${relPath} 声明为 manifest-verifier 却没有「读 manifest.json + 比对 manifest 字段」的自校验结构`
    }
    case 'anchor':
      // 故意独立的历史锚点，唯一结构前提是它确实位于 test/ 下（期望值 fixture 的归属）。
      return relPath.startsWith('packages/core/test/')
        ? null
        : `${relPath} 声明为 anchor 却不在 packages/core/test/ 下`
    case 'preview-mock':
      // 仅此一处，且必须是 renderer 的 api.ts（见文件头第 5 条：故意不绑定、可漂移）。
      return relPath === 'apps/desktop/src/renderer/src/lib/api.ts'
        ? null
        : `${relPath} 声明为 preview-mock 却不是 renderer 的 api.ts`
    case 'guard':
      // 本守卫自身：为了搜出别的手抄，它必须把三个可区分哈希写进 IDENTITY_HASHES，于是也被派生器
      // 命中。结构前提是它确实是这个文件、且这些哈希住在 IDENTITY_HASHES 数组里（而不是散落成新的
      // 消费点）——保证「守卫因自带靶子被命中」这件事本身可核。
      return relPath === 'packages/core/test/ctxmux-version-binding.test.ts' && /const IDENTITY_HASHES =/.test(text)
        ? null
        : `${relPath} 声明为 guard 却不是本守卫文件或没有 IDENTITY_HASHES 靶子数组`
    default:
      return `${relPath} 的角色 ${role} 未知`
  }
}

describe('CtxMux 运行时版本/commit 绑定到 SHA 校验过的原件（F2）', () => {
  const sources = new Map<string, ts.SourceFile>()
  for (const path of new Set(BINDING_SITES.map((site) => site.path))) {
    sources.set(path, parse(path, readFileSync(path, 'utf8')))
  }

  it('每个消费点的属性值都是那个已导入常量，而不是手抄的字面量', () => {
    for (const site of BINDING_SITES) {
      const values = propertyValues(sources.get(site.path)!, site.key)
      // 该键至少出现一次；出现的每一次都必须绑定到期望的标识符（否则「某一处被改回字面量」漏网）。
      expect(
        values.length,
        `${site.path} 里找不到属性键 ${site.key}——消费点被移走或改名了，判据已失去靶子`
      ).toBeGreaterThanOrEqual(1)
      for (const value of values) {
        expect(
          isIdentifierReference(value, site.expected),
          `${site.path} 的 ${site.key} 不是对已导入常量 ${site.expected} 的引用（值节点类型 ` +
            `${ts.SyntaxKind[value.kind]}）——手抄的字面量会在 artifact bump 时静默漂移`
        ).toBe(true)
      }
    }
  })

  it('client.ts 确实从 ctxmux-run-adapter 具名导入了这两个常量（否则绑的是别处的同名符号）', () => {
    const imported = namedImportsFrom(sources.get(clientPath)!, ADAPTER_MODULE_SPECIFIER)
    expect(imported.has('CTXMUX_VERSION'), 'client.ts 没从 adapter 导入 CTXMUX_VERSION').toBe(true)
    expect(imported.has('CTXMUX_COMMIT'), 'client.ts 没从 adapter 导入 CTXMUX_COMMIT').toBe(true)
  })

  it('自检：这两个常量确实是从 adapter 导出的运行时值（导入求值成功即证明可达）', () => {
    // 若 adapter 没导出它们，本文件顶部的 import 会在编译期失败；这里再对取值做一次形状断言，
    // 确保它们是非空字符串而不是某种意外的 undefined 透传。
    expect(typeof CTXMUX_VERSION).toBe('string')
    expect(CTXMUX_VERSION.length).toBeGreaterThan(0)
    expect(typeof CTXMUX_COMMIT).toBe('string')
    expect(CTXMUX_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  it('自检：若把某个消费点改回字面量，判据必红（证明它不是恒真）', () => {
    // 取 client.ts 真实源码，把 `version: CTXMUX_VERSION` 注入成 `version: '0.1.0'`，重跑同一判据。
    const original = readFileSync(clientPath, 'utf8')
    const mutated = original.replace('version: CTXMUX_VERSION', "version: '0.1.0'")
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    const value = propertyValues(parse(clientPath, mutated), 'version')[0]!
    // 变异体里 version 的值是字符串字面量，isIdentifierReference 必须判 false（即判据会红）。
    expect(isIdentifierReference(value, 'CTXMUX_VERSION')).toBe(false)
    expect(ts.isStringLiteral(value)).toBe(true)
  })

  describe('覆盖面派生：凡提到身份字面量的 tracked 文件都必须已被分类', () => {
    const discovered = identityMentioningFiles()

    it('自检：派生器非空且能看见已知成员（扫描根写错返回空集时此断言必红）', () => {
      expect(
        discovered.length,
        '派生集合为空——git grep 没跑起来或扫描根/pathspec 写错了；这是空过陷阱，必须响亮变红'
      ).toBeGreaterThan(5)
      expect(
        discovered,
        'SSOT adapter 文件没出现在派生集合里——提取器坏了或漏了 commit 哈希那一路'
      ).toContain('packages/core/src/ctxmux-run-adapter.ts')
      expect(
        discovered,
        'runtime-paths（manifest-sha SSOT）没出现在派生集合里——漏了 sha256 那一路'
      ).toContain('packages/core/src/runtime-paths.ts')
    })

    it('派生集合恰好等于分类表（新增一处未分类手抄 → 多出成员 → 红）', () => {
      expect(new Set(discovered)).toEqual(new Set(Object.keys(IDENTITY_ROLES)))
    })

    it('每个分类文件的角色结构前提都成立（角色名声称的关系必须在文件里真实存在）', () => {
      for (const [relPath, role] of Object.entries(IDENTITY_ROLES)) {
        expect(roleViolation(relPath, role), `${relPath} 的 ${role} 结构前提不成立`).toBeNull()
      }
    })

    it('自检：把派生器改成返回空集时，上面的对账断言会红（证明它不是恒真）', () => {
      // 模拟「提取器被中和成空集」这个变异：对账断言拿空集比分类表必然不等。
      const empty = new Set<string>()
      expect(empty).not.toEqual(new Set(Object.keys(IDENTITY_ROLES)))
      // 已知成员断言在空集上也必红。
      expect([...empty]).not.toContain('packages/core/src/ctxmux-run-adapter.ts')
    })
  })
})
