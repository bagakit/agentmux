import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { DESKTOP_TEST_TYPE_ERROR_BASELINE } from './type-tree-error-baseline.js'

/**
 * 这个文件守的是一件事：**桌面测试树始终被 tsc 真正编译，且它的类型错误只减不增**。
 *
 * 事故形态（本仓反复发生）：`apps/desktop/tsconfig.json` 的 `include` 只有 `src/**`，`test/` 从不进
 * 编译器。于是测试里写的编译期判据（`Record<Union, true>` 穷举表、`satisfies`）是从不执行的死代码，
 * 有一张这样的表「一辈子没跑过」；提交信息拿「tsc exit 0」给纯 test 改动背书而那句话什么都不证明；
 * 删生产字段在测试里留下的悬空引用无人看见；跨 fixture 的类型漂移能让整个 suite 绿着而 tsc 退 2。
 * 相邻的 `packages/core` 反而检查它的 `test/**`——这份不对称就是缺陷的根。
 *
 * 判据是**tsc 这次真的编译了哪些文件、真的报了多少错**，不是配置文件里有没有那行 glob。查文本会在两种
 * 情形假绿：include 写了 `test/**` 却被 `exclude` 覆盖、或 glob 少写一个字符从而一个文件都不匹配。
 * 所以这里真的去问 tsc（走 `apps/desktop/tsconfig.test.json`，它 extends 主 tsconfig，因此工程标志
 * 与生产编译**逐字一致**——不是另开一套宽松标志自欺）。
 *
 * 为什么是棘轮而不是「零错误」：把 test 纳入检查那一刻，历史积累的 377 个错误一起显形（100 文件，
 * 2026-09-07 实测）。一次清完既不安全也不该阻塞守卫落地，于是冻结每文件上限，只许下降、不许有新文件
 * 开始报错。这样「新判据落在未检查文件」「fixture 相对生产类型漂移」这一族缺陷从此当场变红。
 */

const DESKTOP_DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const TEST_CONFIG = path.join(DESKTOP_DIR, 'tsconfig.test.json')

const require = createRequire(import.meta.url)
/** 用被本仓锁定的那一份 typescript（5.9.x）的 tsc，别撞上全局 PATH 里版本不同的 tsc。 */
const TSC_BIN = path.join(path.dirname(require.resolve('typescript')), '..', 'bin', 'tsc')

/**
 * 反向自检探针的文件名前缀。#831。
 *
 * 探针必须落在 `test/` 里——那正是 tsc 的扫描根，不进去就证不到「这棵树真的被编译」。代价是
 * **它对同时在跑的另一个进程可见**：探针在盘上的那几秒，另一个 vitest 实例的 tsc 会把它一起
 * 编译，于是把别人的探针报成「基线外新报错文件」。这不是抖动，是确定性的竞态，窗口就是探针的
 * 生命期；本仓已两次独立观测到（一次三连跑复现，一次并发批跑）。
 *
 * 所以要两件事，缺一不可：
 * - 文件名带 pid，两个进程各写各的，`rmSync` 不会删掉对方正在用的那份；
 * - 下面两处枚举都把整个前缀族**排除**掉，别人的探针不算「新报错文件」，也不算「漏编译的源文件」。
 *
 * 排除是一道口子：真有人提交一个叫这个前缀的文件，它就被静默豁免了。`没有任何入库文件用探针前缀`
 * 那条自检把口子焊死——排除只对未入库的临时探针生效。
 */
const PROBE_PREFIX = 'test/__type_tree_probe__'
const probeRel = `${PROBE_PREFIX}.${process.pid}.test.ts`

/** 是不是（任何进程的）反向自检探针。 */
function isTypeTreeProbe(relativePath: string): boolean {
  return relativePath.startsWith(PROBE_PREFIX)
}

/**
 * 「基线外开始报错的文件」——棘轮的核心判据。
 *
 * 抽成函数是为了让下面那条并发判据**执行这一份**，而不是照抄一份过滤链。抄一份的话，原件里的
 * `isTypeTreeProbe` 排除被删掉时副本仍然正确，于是判据全绿——实测过的假绿形态。
 */
function newlyErroringFiles(run: TscRun): string[] {
  return [...run.errorsByFile]
    .filter(([file]) => DESKTOP_TEST_TYPE_ERROR_BASELINE[file] === undefined)
    // 别人（另一个 vitest 进程）的探针是**故意**带类型错误的，且永远不该进基线。把它算成「新报错
    // 文件」就是本判据唯一的假红来源（#831 两次观测都落在这里）。
    .filter(([file]) => !isTypeTreeProbe(file))
    .map(([file, count]) => `${file} (+${count})`)
}

interface TscRun {
  /** tsc 编译进这一轮的、`apps/desktop/test/` 下的文件，仓相对形式（`test/...`）。 */
  readonly compiledTestFiles: ReadonlySet<string>
  /** 每个 `test/...` 文件的错误条数（仅含至少报过一次错的文件）。 */
  readonly errorsByFile: ReadonlyMap<string, number>
  /** 诊断总条数（`error TS...` 行数）。 */
  readonly totalErrors: number
}

/** tsc 诊断行前缀：`test/foo.test.ts(12,3): error TS1234: ...`。只认相对路径形态。 */
const DIAGNOSTIC_RE = /^(test\/[^\s(]+\.tsx?)\(\d+,\d+\): error TS\d+/

/**
 * 跑一次 `tsc --noEmit --listFiles`，把「编译了哪些文件」和「报了哪些错」一并解析出来。
 *
 * `--listFiles` 让 tsc 把它实际纳入的每个文件打到 stdout（用它自己的解析规则，而不是我们手写 glob 去
 * 猜——手写 glob 正是会假绿的那种判据）。诊断也走 stdout（`pretty false` 关掉颜色与多行折叠，保证每条
 * 错误独占一行、前缀稳定可解析）。tsc 有错时退出码非 0，execFileSync 会抛，用 catch 里的 stdout 兜住。
 */
function runTsc(configPath: string): TscRun {
  let stdout: string
  try {
    stdout = execFileSync(
      process.execPath,
      [
        TSC_BIN,
        '--noEmit',
        '--listFiles',
        '--pretty',
        'false',
        '-p',
        configPath
      ],
      {
        cwd: DESKTOP_DIR,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  } catch (error) {
    // tsc 报错即退出码非 0；诊断与文件清单都在 stdout 上。
    const withStdout = error as { stdout?: string | Buffer }
    if (withStdout.stdout == null) throw error
    stdout = withStdout.stdout.toString()
  }

  const compiledTestFiles = new Set<string>()
  const errorsByFile = new Map<string, number>()
  let totalErrors = 0

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    // 文件清单行：绝对路径，落在 apps/desktop/test/ 下的换算成 test/ 相对形式。
    if (line.startsWith('/') && (line.endsWith('.ts') || line.endsWith('.tsx'))) {
      const testPrefix = path.join(DESKTOP_DIR, 'test') + path.sep
      if (line.startsWith(testPrefix)) {
        compiledTestFiles.add('test/' + line.slice(testPrefix.length))
      }
      continue
    }

    const diagnostic = line.match(DIAGNOSTIC_RE)
    if (diagnostic) {
      totalErrors += 1
      const file = diagnostic[1]!
      errorsByFile.set(file, (errorsByFile.get(file) ?? 0) + 1)
    }
  }

  return { compiledTestFiles, errorsByFile, totalErrors }
}

/** 仓根 `apps/desktop/test/` 下所有 `*.test.ts(x)` 的仓相对路径，用来核对 tsc 一个都没漏掉。 */
function allAuthoredTestFiles(): string[] {
  const listed = execFileSync(
    'git',
    ['-C', DESKTOP_DIR, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'test'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  return listed
    .split('\0')
    .filter(
      (line) =>
        /\.tsx?$/.test(line) &&
        !line.endsWith('.d.ts') &&
        // 别人（另一个 vitest 进程）的反向自检探针：`--others` 会列出它，而它在我们这一轮 tsc 之后才
        // 落盘、或在之前就被删掉，于是「authored 里有、compiledTestFiles 里没有」——一条纯竞态的假红。
        !isTypeTreeProbe(line) &&
        existsSync(path.join(DESKTOP_DIR, line))
    )
}

// 整轮只跑两次 tsc（~6s 一次）：一次基线，一次带探针的反向自检。下面所有断言共用这两份产出。
const baseRun = runTsc(TEST_CONFIG)

/**
 * 反向自检那一轮：在 `test/` 下真的摆一个带类型错误、且不在基线里的探针，重跑 tsc。
 *
 * 提到模块作用域是为了让「棘轮逮到它」与「两处枚举把它排除掉」分成各自的 `it` 判——挤在一个 `it` 里
 * 时，先失败的那条会让后面的成为死代码。
 */
const probedRun = (() => {
  const probeAbs = path.join(DESKTOP_DIR, probeRel)
  writeFileSync(
    probeAbs,
    [
      "import { it, expect } from 'vitest'",
      '',
      '// 故意的类型错误：把 string 赋给 number。仅供守卫反向自检，随即删除。',
      'const probe: number = "型别不符"',
      '',
      "it('probe', () => { expect(typeof probe).toBe('string') })",
      ''
    ].join('\n')
  )
  try {
    return runTsc(TEST_CONFIG)
  } finally {
    rmSync(probeAbs, { force: true })
  }
})()

describe('desktop test tree is type-checked, and its errors only ratchet down', () => {
  it('每个 test 源文件都真的进了这次 tsc 编译（挡住 include 收窄／glob 写错）', () => {
    const authored = allAuthoredTestFiles()
    // 自检：至少得有相当数量的测试文件，否则枚举本身出错会让下面恒真。
    expect(authored.length).toBeGreaterThan(200)

    const missing = authored.filter((file) => !baseRun.compiledTestFiles.has(file))
    // 一个都不能漏：漏掉的文件里写的任何编译期判据都是死代码。
    expect(missing).toEqual([])
  }, 60_000)

  it('基线外的文件不许开始报错（新引入的类型漂移）', () => {
    expect(newlyErroringFiles(baseRun)).toEqual([])
  }, 60_000)

  it('基线里的每个数字都必须**等于**实测值，不许高也不许低（棘轮）', () => {
    // 为什么是相等而不是「不超过」：上限式的棘轮有一个致命的静默面——**把数字调高**。
    // 那正是本守卫的文件头写明「绝不允许」的动作，可上限判据在定义上就放行它。曾经兜底的
    // `totalErrors <= TOTAL` 帮不上忙：那个 TOTAL 是从这张同一张表 `.reduce()` 出来的，改一条
    // 数字两边一起动，不等式恒成立。实测：把某文件从 13 调到 40，三条断言全绿。
    //
    // 相等还顺带消灭第二种松弛：某个文件的错误被别的改动顺手修掉、基线却没跟着降。空出来的额度
    // 是一道无人看守的门，真回归可以躲在里面。落地前实测就有三条这样的陈旧数字（共 6 点额度）。
    const tooHigh: string[] = []
    const tooLow: string[] = []

    for (const [file, expected] of Object.entries(DESKTOP_TEST_TYPE_ERROR_BASELINE)) {
      const actual = baseRun.errorsByFile.get(file) ?? 0
      if (actual > expected) tooHigh.push(`${file}: 实测 ${actual} > 基线 ${expected}（在带病文件上又叠了一层）`)
      else if (actual < expected)
        tooLow.push(
          actual === 0
            ? `${file}: 已降到 0，请把这条从基线里删掉`
            : `${file}: 实测 ${actual} < 基线 ${expected}，请把基线改成 ${actual}`
        )
    }

    expect(tooHigh).toEqual([])
    expect(tooLow).toEqual([])
  }, 60_000)

  it('这套判据不是恒绿：故意种一个类型错误，棘轮必须逮到（反向自检）', () => {
    // 若哪天 tsconfig.test.json 不再收 test/、或 tsc 调用被改坏而静默不报错，上面两条会变成
    // 「编译了 0 个文件、0 个错误」的假绿。`probedRun` 那一轮在 test/ 下真的摆了一个带类型错误、且
    // **不在基线里**的探针文件，这里要求它：(a) 被编译到；(b) 错误真的记到它名下。
    //
    // 判的是 `runTsc` 的原始产出，**不是**上面那条 it 的 `newlyErroring`——那条已经把整个探针前缀族
    // 排除掉了（#831）。反向自检必须绕过那道排除，否则它证的是「排除生效」而不是「棘轮有牙」。
    expect(DESKTOP_TEST_TYPE_ERROR_BASELINE[probeRel]).toBeUndefined()
    // (a) 探针确实进了编译——否则「被检查」这件事没被证到。
    expect(probedRun.compiledTestFiles.has(probeRel)).toBe(true)
    // (b) 探针的错误被记到它名下，且它不在基线里 => 棘轮的原始判据认定它是「基线外新报错文件」。
    expect(probedRun.errorsByFile.get(probeRel) ?? 0).toBeGreaterThan(0)
  }, 60_000)

  it('探针不会把「基线外新报错文件」这条判据打红（#831 的并发假红面）', () => {
    // 这条钉的就是修法本身，且**不靠并发**去撞：`probedRun` 里确实有一个前缀族的报错文件（上一条
    // 刚证过），把那一轮喂给**生产用的同一个** `newlyErroringFiles`，结果必须是空。
    //
    // 走同一个函数是关键：照抄一份过滤链的话，原件里的排除被删掉时副本仍然正确，判据全绿——实测
    // 过的假绿形态。真正暴露它的场景（两个 vitest 同时跑）在单跑的 CI 里永远不出现。
    expect(newlyErroringFiles(probedRun)).toEqual([])
  }, 60_000)

  it('探针不会把「每个 test 源文件都进了编译」这条判据打红（#831 的另一半）', () => {
    // 对称的另一面：别人的探针会被 `git ls-files --others` 列出来，却不在**我们这一轮**的 tsc 产出里
    // （它在我们跑完之后才落盘，或跑之前就被删了），于是 `missing` 非空——同一个竞态的第二种形态。
    //
    // 用一个**别的 pid** 的探针名落盘来模拟那一刻：它对 git 可见，但 baseRun 里没有它。
    const foreignRel = `${PROBE_PREFIX}.${process.pid + 1}.test.ts`
    const foreignAbs = path.join(DESKTOP_DIR, foreignRel)
    expect(baseRun.compiledTestFiles.has(foreignRel)).toBe(false)
    writeFileSync(foreignAbs, 'const foreign: number = "型别不符"\nexport default foreign\n')

    try {
      // 自检：过滤前 git 确实把它列出来了，否则下面那条恒真。
      const unfiltered = execFileSync(
        'git',
        ['-C', DESKTOP_DIR, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'test'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      )
      expect(unfiltered.split('\0').filter(isTypeTreeProbe)).toEqual([foreignRel])

      // 真判据：`allAuthoredTestFiles()` 必须把它挡在外面，于是 missing 仍为空。
      const authored = allAuthoredTestFiles()
      expect(authored.filter(isTypeTreeProbe)).toEqual([])
      expect(authored.filter((file) => !baseRun.compiledTestFiles.has(file))).toEqual([])
    } finally {
      rmSync(foreignAbs, { force: true })
    }
  }, 60_000)

  it('探针前缀没有被任何入库文件占用（把两处「排除」焊死在临时探针上）', () => {
    // 上面两处枚举都按前缀把探针族排除掉，这是并发安全的代价，也是一道口子：任何**入库**的文件只要
    // 名字以这个前缀开头，它的类型错误就被静默豁免——正是本守卫存在意义的反面。
    //
    // 判据取 `--cached`（只问「入库了吗」），不带 `--others`：未入库的临时探针正是要放行的那一类。
    const tracked = execFileSync('git', ['-C', DESKTOP_DIR, 'ls-files', '--cached', '-z', '--', 'test'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
      .split('\0')
      .filter((line) => line.length > 0)

    // 自检：枚举本身不能是空的，否则下面那条恒真。
    expect(tracked.length).toBeGreaterThan(200)
    expect(tracked.filter(isTypeTreeProbe)).toEqual([])
  }, 60_000)

  it('探针文件名带 pid，两个并发进程不会互相拆台（#831 的竞态修法）', () => {
    // 这条钉的是修法本身：文件名必须**随进程变化**。写成固定名时，两个 vitest 实例会看见对方盘上的
    // 探针——一个把它报成「基线外新报错文件」，另一个的 rmSync 把它删掉——于是确定性地假红。
    // 本仓两次独立观测到这个形态（一次三连跑，一次并发批跑）。
    expect(probeRel).toContain(String(process.pid))
    expect(isTypeTreeProbe(probeRel)).toBe(true)
    // 前缀本身不得就是完整文件名：否则「带 pid」这件事在拼接层被绕过也没人发现。
    expect(probeRel).not.toBe(`${PROBE_PREFIX}.test.ts`)
  })
})

afterAll(() => {
  // 兜底：万一上面的 finally 没跑到，别把探针留在树里。只删**自己这个进程**那一份——
  // 别的 vitest 进程的探针正被它自己用着（#831）。
  const probeAbs = path.join(DESKTOP_DIR, probeRel)
  if (existsSync(probeAbs)) rmSync(probeAbs, { force: true })
})
