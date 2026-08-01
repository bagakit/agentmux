import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { reportStartupFailureAndExit, startupFailureExitIo, type StartupFailureExitIo } from '../src/main/startup-failure-exit.js'
import { startupFailureNotice } from '../src/main/startup-failure-notice.js'

// ---------------------------------------------------------------------------
// 启动失败的**动作序列**：告知 → 清理 → 退出。
//
// 为什么这个文件存在：这段序列原先整段写在 `index.ts` 的 `exitAfterFailure` 里，而那个位置对测试
// 不可达（在 `startPrimaryInstance()` 闭包内，依赖 dialog / app / configStore）。于是
// `startup-failure-notice.test.ts` 那一族只能落在**源码文本**上——而文本看不见执行：实测在那个
// 函数体第一行插一句 `if (configStore) return`，整条通知路径变成 no-op 而 11 条全绿
// （记忆 grep-guard-cannot-see-early-return）。
//
// 抽出来只解决一半（记忆 extracting-to-lib-only-fixes-half）：内容与顺序现在可测，但「壳有没有
// 被执行到、有没有接到真东西上」照旧没人守。所以分两族：
//
//   1. 行为层 —— 这个纯序列做对了那五件事（下面第一个 describe）；
//   2. 接线层 —— `index.ts` 里那个壳**恰好只有一句表达式**，没有语句可插，且每个依赖都接在真的
//      electron / ConfigStore 上（下面第二个 describe）。
//
// 两层各自变异只红各自那层：删掉 lib 里的 showErrorBox 只红第 1 族，把壳里的 `dialog.showErrorBox`
// 换成别的只红第 2 族。
// ---------------------------------------------------------------------------

const CONFIG_PATH = '/Users/someone/Library/Application Support/AgentMux/agentmux.config.json'

/** 记录调用顺序的 io。顺序是承重的，所以每个动作都往同一条时间线上写一格。 */
function recordingIo(overrides: Partial<StartupFailureExitIo> = {}): {
  io: StartupFailureExitIo
  order: string[]
  dialogs: Array<{ title: string; body: string }>
  diagnostics: string[]
  exitCodes: number[]
} {
  const order: string[] = []
  const dialogs: Array<{ title: string; body: string }> = []
  const diagnostics: string[] = []
  const exitCodes: number[] = []
  const io: StartupFailureExitIo = {
    configPath: CONFIG_PATH,
    showErrorBox(title, body) {
      order.push('dialog')
      dialogs.push({ title, body })
    },
    async disposeOwners() {
      order.push('dispose')
    },
    writeDiagnostic(line) {
      order.push('stderr')
      diagnostics.push(line)
    },
    exit(code) {
      order.push('exit')
      exitCodes.push(code)
    },
    ...overrides
  }
  return { io, order, dialogs, diagnostics, exitCodes }
}

describe('启动失败的收尾序列', () => {
  it('弹的是那个纯函数算出来的标题与正文，不是就地拼的第二份文案', async () => {
    // 判据是「同一个取值层」。就地拼串的实现会绕过 startup-failure-notice.test.ts 那六条内容断言：
    // 文案能对一次，之后必然与纯函数漂移。
    const error = new Error('Refusing to retire a config whose host list the schema cannot read')
    const { io, dialogs } = recordingIo()

    await reportStartupFailureAndExit(error, io)

    const expected = startupFailureNotice(error, { configPath: CONFIG_PATH })
    expect(dialogs).toEqual([{ title: expected.title, body: expected.body }])
  })

  it('对话框排在清理之前——清理一挂住，用户就永远看不到那段话', async () => {
    // 顺序判据。`disposeOwners()` 里任何一个 owner 卡住，「先清理再告知」的版本就永远不弹那个框，
    // 症状与完全没有它一字不差。这里用 never-settle 把「挂住」做成真的挂住，而不是靠读顺序推断。
    const { io, dialogs, order } = recordingIo({ disposeOwners: () => new Promise(() => {}) })

    void reportStartupFailureAndExit(new Error('boom'), io)
    await Promise.resolve()

    expect(dialogs, '清理挂住时一个字都没弹出来').toHaveLength(1)
    expect(order.indexOf('dialog')).toBeLessThan(order.length)
    expect(order).not.toContain('exit')
  })

  it('顺序是 stderr → 对话框 → 清理 → 退出', async () => {
    const { io, order } = recordingIo()

    await reportStartupFailureAndExit(new Error('boom'), io)

    expect(order).toEqual(['stderr', 'dialog', 'dispose', 'exit'])
  })

  it('退出码是 1——启动失败不能装成正常退出', async () => {
    // exit(0) 会让 shell、launchd、以及打包冒烟脚本都认为这次启动成功了。
    const { io, exitCodes } = recordingIo()

    await reportStartupFailureAndExit(new Error('boom'), io)

    expect(exitCodes).toEqual([1])
  })

  it('对话框弹不出来时照旧退出，且把那个异常也写进 stderr', async () => {
    // 无头环境（CI、测试、没有 GUI 的远端）里 showErrorBox 会抛。吞掉它不算错，但因此不退出就是
    // 留下一个既没有窗口也不结束的进程——比闪一下就没了更糟。
    const { io, exitCodes, diagnostics } = recordingIo({
      showErrorBox: () => {
        throw new Error('cannot show a dialog in a headless environment')
      }
    })

    await reportStartupFailureAndExit(new Error('boom'), io)

    expect(exitCodes, '对话框抛出后没有退出：进程会永远挂着').toEqual([1])
    expect(diagnostics.join('\n')).toContain('headless environment')
  })

  it('清理抛错时照旧退出，且把清理的异常也写进 stderr', async () => {
    // 这条与上一条是**两个**独立的 try：只包一个的实现能让另一个把整条路径炸掉在 exit 之前。
    const { io, exitCodes, diagnostics } = recordingIo({
      disposeOwners: async () => {
        throw new Error('runtime disposal failed')
      }
    })

    await reportStartupFailureAndExit(new Error('boom'), io)

    expect(exitCodes, '清理抛错后没有退出').toEqual([1])
    expect(diagnostics.join('\n')).toContain('runtime disposal failed')
  })

  it('抛出物是 undefined 时也照样弹框并退出——不许按 error 真假分支', async () => {
    // `Promise.reject()` 不带值、`throw undefined` 都会走到这里。诊断串这时没什么信息量，但
    // 「东西还在盘上、在这个文件里」这两句照样是用户唯一的线索。按 `error` 真假加一道 if 是这里
    // 最自然的写坏方式，所以专门钉住。
    const { io, dialogs, exitCodes } = recordingIo()

    await reportStartupFailureAndExit(undefined, io)

    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.body).toContain(CONFIG_PATH)
    expect(exitCodes).toEqual([1])
  })

  it('配置文件路径原样传给那个纯函数——不在这一层重算或补默认值', async () => {
    // 手抄/重算一份路径的症状是「对话框指着一个不存在的文件」，比不给路径更糟。
    const { io, dialogs } = recordingIo({ configPath: '/tmp/elsewhere/agentmux.config.json' })

    await reportStartupFailureAndExit(new Error('boom'), io)

    expect(dialogs[0]!.body).toContain('/tmp/elsewhere/agentmux.config.json')
    expect(dialogs[0]!.body).not.toContain(CONFIG_PATH)
  })
})

// ---------------------------------------------------------------------------
// 接线层：`index.ts` 里那个壳。
//
// 抽进 lib 之后剩下的问题是「壳里有没有别的语句」。上面那个早退变异之所以能存活，正是因为壳里
// **有语句可插**。所以这一族的核心判据不是「壳里出现了某个字符串」，而是「壳里恰好只有一句
// 表达式」——没有语句，就没有地方插早退。
// ---------------------------------------------------------------------------
describe('index.ts 的壳只是一句转发', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

  /**
   * 壳的文本。左界取它自己的声明，右界取下一个 `function` 声明——只取左界会一直切到文件末尾，
   * 邻近函数里的任何东西都能让判据通过（记忆 section-slice-without-right-bound）。
   */
  const shell = ((): string => {
    const start = source.indexOf('const exitAfterFailure = ')
    if (start < 0) return ''
    const next = source.indexOf('\n  async function ', start + 1)
    const alsoNext = source.indexOf('\n  function ', start + 1)
    const end = [next, alsoNext].filter((index) => index > 0).sort((a, b) => a - b)[0] ?? source.length
    return source.slice(start, end)
  })()

  it('前提自检：切出来的确实是那个壳，且没有一直切到文件末尾', () => {
    // 这条先红时，下面几条的失败读起来才不会像「忘了接线」。
    expect(shell).toMatch(/const exitAfterFailure = /)
    // 右界有效：`buildWindow` 是它后面那个函数，不许被卷进来。
    expect(shell).not.toMatch(/buildWindow/)
  })

  it('壳是箭头函数体形式的一句表达式——没有语句可插，早退变异无处落脚', () => {
    // 这是这一族里唯一守得住那个原始缺陷的断言。`=> {` 一出现，壳里就有了语句位置，
    // 而文本判据看不见语句的执行（那正是修复前 11 条全绿的原因）。
    expect(shell, '壳退回了块体：现在可以在第一行插早退而这一族照旧全绿').not.toMatch(
      /const exitAfterFailure = [^\n]*=>\s*\{/
    )
    expect(shell).toMatch(/=>\s*\n?\s*reportStartupFailureAndExit\(/)
    // 分号/语句关键字都不该出现在这一句里（对象字面量的逗号不算）。
    expect(shell).not.toMatch(/\b(if|for|while|return|try|await)\b/)
  })

  it('五个依赖都接在真的东西上，不是接了一个恒等 stub', () => {
    // 每一条都是「送不到」的一种：路径手抄、对话框没接、清理没接、诊断没接、不退出。
    // `dialog` / `app` 以简写属性传整个对象（见 startup-failure-exit.ts 里那段 receiver 说明），
    // 而这个文件里叫这两个名字的绑定只有顶部那两个 electron import，所以简写就等于接到了真东西。
    expect(shell, '配置路径没取自 ConfigStore 自己').toMatch(/configPath:\s*configStore\.filePath/)
    expect(shell, '对话框没接到 electron 的 dialog').toMatch(/^\s+dialog,$/m)
    expect(shell, '清理没接到 disposeOwners').toMatch(/^\s+disposeOwners,$/m)
    expect(shell, '诊断没写到 stderr').toMatch(/stderr:\s*process\.stderr\b/)
    expect(shell, '退出没接到 electron 的 app').toMatch(/^\s+app$/m)
    // 路径不许在这里现取：`app.getPath` 会与 ConfigStore 自己的解析漂移。
    expect(shell).not.toMatch(/getPath\(/)
  })

  it('壳里全是裸引用——没有实参位置，写错实参的变异无处落脚', () => {
    // 这一条治的是上面那族的盲点：`toMatch(/app\.exit\(/)` 对 `app.exit(code)` 与 `app.exit(0)`
    // 一视同仁。实测把壳里的 `exit` 写成 `() => app.exit(0)`，33 条全绿且 tsc 干净
    //（`noUnusedParameters` 没开），而症状是启动失败退 0——打包冒烟脚本把崩溃读成成功。
    // 同形的还有 `showErrorBox(body, title)` 参数对调、`disposeOwners: () => Promise.resolve()`。
    //
    // 判据是**结构**而不是那几个名字：壳里一个箭头都不许有。适配挪进 `startupFailureExitIo`
    // 之后那里的实参由下面那族真跑一遍钉住，于是这两层各自变异只红各自那层。
    const arrowsInShell = shell.match(/=>/g) ?? []
    expect(
      arrowsInShell.length,
      `壳里出现了 ${arrowsInShell.length} 个箭头（只允许最外层那一个）：实参又变成无人守的了`
    ).toBe(1)
    // 组装必须走那个可测的函数，而不是在这里拼一个对象字面量。
    expect(shell, '没有走 startupFailureExitIo：适配又回到了壳里').toMatch(
      /startupFailureExitIo\(/
    )
  })

  it('两个失败入口都还走这个壳', () => {
    // 引导期的 catch 与 before-quit 的清理失败。少一个的症状是那条路径静默退出。
    // 数的是**调用**：声明写作 `const exitAfterFailure = (`，不匹配这个模式。
    expect(source.split('exitAfterFailure(').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('index.ts 不再自己拼那段文案——取值层只有一处', () => {
    // 壳被压成一句之后，`startupFailureNotice` 只应该由 lib 调用。index.ts 里再出现它，
    // 就意味着有第二处取值层，而两处必然漂移。
    expect(source).not.toMatch(/startupFailureNotice\(/)
  })
})

// ---------------------------------------------------------------------------
// 第 3 族：组装层。壳里那三个箭头函数的**实参**此前无人守——文本判据看不见实参，
// 所以这三件事各自都能静默写错：
//
//   exit: () => app.exit(0)                    → 启动失败退 0，冒烟脚本读成成功（最重）
//   showErrorBox: (t, b) => box(b, t)          → 对话框标题正文对调（外观降级）
//   writeDiagnostic: (l) => stderr.write(l)     → 少了换行，多行诊断粘成一行
//
// 适配挪进 `startupFailureExitIo` 之后，这三件事在这里各有一条断言，且这一族与接线层
// 各自变异只红各自那层：改坏这里的转发只红本族，把适配搬回壳里只红接线层那条箭头计数。
// ---------------------------------------------------------------------------

describe('宿主 API 组装成 io', () => {
  /**
   * 记录裸 API 收到了什么。每一格都是壳里此前那个实参能写错的地方。
   *
   * `dialog` 与 `app` 是**对象**，且它们的方法记录自己的 `this`：electron 里这两个是 gin 原生绑定，
   * 把方法摘下来（`exit: app.exit`）之后 receiver 就没了，真机上调用直接抛 Illegal invocation，
   * 而普通对象上摘下来照样能调——所以「有没有丢 receiver」必须由 `this` 自己来说，否则这个盲点
   * 在测试里完全不可观测。
   */
  function recordingHost(): {
    host: Parameters<typeof startupFailureExitIo>[0]
    boxes: Array<{ title: string; body: string }>
    writes: string[]
    exitCodes: number[]
    disposals: number
    receivers: unknown[]
  } {
    const boxes: Array<{ title: string; body: string }> = []
    const writes: string[] = []
    const exitCodes: number[] = []
    const receivers: unknown[] = []
    let disposals = 0
    const dialog = {
      showErrorBox(this: unknown, title: string, body: string) {
        receivers.push(this)
        boxes.push({ title, body })
      }
    }
    const app = {
      exit(this: unknown, code: number) {
        receivers.push(this)
        exitCodes.push(code)
      }
    }
    const host = {
      configPath: CONFIG_PATH,
      dialog,
      async disposeOwners() {
        disposals += 1
      },
      stderr: {
        write(chunk: string) {
          writes.push(chunk)
          return true
        }
      },
      app
    }
    return {
      host,
      boxes,
      writes,
      exitCodes,
      receivers,
      get disposals() {
        return disposals
      }
    }
  }

  it('退出码原样转发，不是常量——这是壳里最重的那个实参', () => {
    // 症状：启动失败退 0，shell / launchd / 打包冒烟脚本都把这次崩溃读成成功。
    // 判据用两个**不同**的码：只试一个的话，`() => host.app.exit(1)` 这种写死也会绿。
    const recorder = recordingHost()
    const io = startupFailureExitIo(recorder.host)

    io.exit(1)
    io.exit(3)

    expect(recorder.exitCodes, '退出码没有原样转发——写死的常量会让崩溃冒充成功').toEqual([1, 3])
  })

  it('两个 electron 方法都用它自己的宿主对象当 receiver 调用', () => {
    // 这一条治的是「把方法从宿主上摘下来」那个盲点：`exit: host.app.exit` 在 tsc 与所有普通对象
    // fixture 下都完全正常，而 electron 的 `app` / `dialog` 是 gin 原生绑定，摘下来之后 receiver
    // 就没了，真机上调用抛 Illegal invocation。这条路径抛在这里的结局最坏：启动失败既不弹框
    // 也不退出，留下一个挂着的进程——正是这一族全部断言想防的那个终局。
    const recorder = recordingHost()
    const io = startupFailureExitIo(recorder.host)

    io.showErrorBox('标题', '正文')
    io.exit(1)

    expect(recorder.receivers, 'receiver 不是宿主对象——方法被从 app/dialog 上摘了下来').toEqual([
      recorder.host.dialog,
      recorder.host.app
    ])
  })

  it('对话框的标题与正文不对调', () => {
    const recorder = recordingHost()
    const io = startupFailureExitIo(recorder.host)

    io.showErrorBox('标题在前', '正文在后')

    expect(recorder.boxes, '标题与正文对调了——用户看到长正文当标题').toEqual([
      { title: '标题在前', body: '正文在后' }
    ])
  })

  it('诊断行末尾补换行——由这一层补，壳里不补', () => {
    // 少了换行的症状：连续几行诊断在终端里粘成一行，读不出边界。
    const recorder = recordingHost()
    const io = startupFailureExitIo(recorder.host)

    io.writeDiagnostic('第一行')
    io.writeDiagnostic('第二行')

    expect(recorder.writes, '诊断没补换行，多行会粘成一行').toEqual(['第一行\n', '第二行\n'])
  })

  it('清理接到真的 disposeOwners，不是一个 no-op', () => {
    // 症状：失败路径不清理，留下 daemon / session store 句柄。
    const recorder = recordingHost()
    const io = startupFailureExitIo(recorder.host)

    return io.disposeOwners().then(() => {
      expect(recorder.disposals, '清理没被调用——失败路径泄漏运行时句柄').toBe(1)
    })
  })

  it('配置路径原样带过来，不在这一层重算', () => {
    const io = startupFailureExitIo(recordingHost().host)
    expect(io.configPath).toBe(CONFIG_PATH)
  })

  it('组装出来的 io 真能驱动整条序列——组装与序列接得上', () => {
    // 接缝判据：上面五条各自只看一格，都绿也不能证明这份 io 喂给 `reportStartupFailureAndExit`
    // 之后那五件事真的发生了（记忆 every-segment-guarded-chain-still-fails）。所以把组装出来的
    // 整份 io 原样喂给下游跑一遍，而不是在这里另造一个 io。
    const recorder = recordingHost()

    return reportStartupFailureAndExit(new Error('起不来'), startupFailureExitIo(recorder.host)).then(
      () => {
        expect(recorder.exitCodes, '退出码不是 1').toEqual([1])
        expect(recorder.boxes, '没弹对话框').toHaveLength(1)
        expect(recorder.boxes[0]!.body, '对话框正文里没有配置文件路径').toContain(CONFIG_PATH)
        expect(recorder.writes.join(''), '诊断里没有那条错误').toContain('起不来')
        expect(recorder.disposals, '没清理').toBe(1)
      }
    )
  })
})
