import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * T-010 的真机判据：在一个真实可见的 `WebContentsView` 上走完 snapshot → click(ref) → re-snapshot，
 * 并观察到页面真的变了；外加一条纯源码判据，证这条路**在生产里真有人走**。
 *
 * 两条判据缺一不可，对应任务点名的那个陷阱（某个参考实现的 snapshot 引擎看起来是完整实现，
 * 但它的 CDP 桥接只在测试里被构造，生产走的是 shell out）：
 *
 * - 真机那条证「这套代码在真页面上确实能闭环」。它不证有人调。
 * - 零调用者那条证「生产代码里确实有人调」。它不证调了能用。
 *
 * 与 T-001 的 browser-cdp-render-domain.test.ts 的分工：那条证的是**域可用**（getFullAXTree 有
 * 收获、resolveNode 能解出 objectId），到"解出句柄"为止。它没有证**派发动作之后页面会变**——
 * 而那正是闭环的最后一步，也是唯一无法靠读代码确定的一步。
 *
 * 为什么必须跑真 Electron：本任务要判定的恰恰是真实实现的行为。假的 CDP 对端想让
 * getFullAXTree 返回什么就返回什么，用它跑出来的绿是自证（MEMORY「合成的 fixture 等于自证」）。
 */

const ELECTRON_BINARY: string = createRequire(import.meta.url)('electron') as unknown as string
const SRC_MAIN = new URL('../src/main/', import.meta.url)

/**
 * 探针页：点一下按钮，页面结构**真的变化**——出现一个此前不存在的可交互节点。
 *
 * 判据取"新增一个 AX 节点"而不是"文字变了"：快照的契约是 {ref, role, name} 的节点树，
 * 只改文本的话，一个根本没重新走查、直接返回上一张快照的实现也能让"名字变了"为真。要求出现
 * **新节点**，就必须真的重走了一遍树。
 */
const PROBE_PAGE = `<!doctype html><html><body>
  <button id="probe-button">Reveal</button>
  <input id="probe-input" aria-label="Probe Field" />
  <div id="slot"></div>
  <script>
    document.getElementById('probe-button').addEventListener('click', () => {
      document.getElementById('slot').innerHTML = '<button id="revealed">Revealed Action</button>'
    })
  </script>
</body></html>`

/**
 * 在主进程里跑的探针。结论写进 JSON 报告——stdout 在 Electron 上混着 GPU/沙箱噪声，
 * 用文件是本仓既有做法（与 browser-cdp-render-domain.test.ts、file-editing-probe.ts:133 同形）。
 *
 * **写成 ESM**，因为 package.json 里是 `"type": "module"`。这不是风格问题：用 `require()` 的话
 * Electron 在加载 main 的那一刻就死了，`app.whenReady` 根本不会跑，于是报告文件不存在、探针
 * 一路挂到超时——而超时的样子与「真机上闭环不成立」一模一样（实测踩过，6 条全红 90s）。
 * 判据不能被自己的脚手架伪造成阴性（MEMORY「探针不该赌启动落点」）。
 *
 * 探针调的是 `createBrowserPageDispatch` 与 `BrowserCdpSession` **真身**（由 vite 从 src 打进
 * 临时 bundle，见 buildDispatchBundle）。不是手抄一份走查——手抄的话，这条证明的是"CDP 能做到
 * 这件事"，而不是"我们的代码能做到"。后者才是本任务要的。
 */
const PROBE_MAIN = `
import { app, BrowserWindow, WebContentsView } from 'electron'
import { writeFileSync } from 'node:fs'

const reportPath = process.env.PROBE_REPORT
const pageUrl = process.env.PROBE_PAGE_URL
const report = { schema: 'agentmux.browser-drive-e2e.v2' }

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 900, height: 700, show: true })
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 })

  let session = null
  try {
    const { createBrowserPageDispatch, BrowserCdpSession } = await import('./dispatch.mjs')
    report.loadedProductionModules = true

    await view.webContents.loadURL(pageUrl)
    await new Promise((resolve) => {
      if (view.webContents.isLoadingMainFrame()) view.webContents.once('did-stop-loading', resolve)
      else resolve(undefined)
    })

    // 导航身份由探针持有，跟真实 entry 一样是"外面给的"。改它就等于页面换过了。
    let navigationId = 'nav-1'
    session = BrowserCdpSession.attach(view.webContents)
    report.attached = true

    // ref 账本。探针把它放在内存里而不是磁盘上：这里要判的是「换一次运行还认不认得出」，
    // 而那取决于账本的内容，不取决于它存在哪。落盘那一半由 browser-ref-ledger.test.ts 判。
    let ledger = null
    const contextFor = () => ({
      session,
      pageInfo: () => ({
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        navigationId
      }),
      gotoUrl: async () => { throw new Error('the probe does not navigate') },
      captureScreenshot: async () => ({ stub: true }),
      readLedger: async () => ledger,
      writeLedger: async (next) => { ledger = next },
      note: (text) => { report.healNotes = [...(report.healNotes || []), text] }
    })
    const dispatch = createBrowserPageDispatch(contextFor())

    // ── 第一步：snapshot ────────────────────────────────────────────────
    const first = await dispatch('snapshot', [])
    report.firstNodeCount = first.nodes.length
    report.firstRefs = first.nodes.filter((n) => n.ref).map((n) => n.ref + ':' + n.role + ':' + n.name)
    report.firstMissingFrames = first.missingFrames.length

    const target = first.nodes.find((n) => n.ref && /reveal/i.test(n.name || ''))
    report.targetRef = target ? target.ref : null
    if (!target) throw new Error('snapshot 里找不到那个按钮——按 ref 驱动无从谈起')

    // ── 第二步：按 ref 点。不是坐标、不是键鼠合成 ────────────────────────
    await dispatch('click', [target.ref])
    report.clickDispatched = true

    // ── 第三步：re-snapshot，观察到变化 ─────────────────────────────────
    const second = await dispatch('snapshot', [])
    report.secondNodeCount = second.nodes.length
    report.secondRefs = second.nodes.filter((n) => n.ref).map((n) => n.ref + ':' + n.role + ':' + n.name)
    report.revealedAppeared = second.nodes.some((n) => /revealed/i.test(n.name || ''))

    // snapshotText 是 Agent 实际读到的那一份。它必须**真的带着把手**，
    // 否则 Agent 读完一段好看的文本却无从下手。
    const text = await dispatch('snapshotText', [])
    report.textMentionsRef = typeof text === 'string' && text.includes(second.nodes.find((n) => n.ref).ref)

    // 填输入框走的是 setter + input/change 事件。只设 value 的话 React/Vue 的受控输入
    // 完全看不见这次修改——表现为"填了但提交的是空的"。
    const field = second.nodes.find((n) => n.ref && /probe field/i.test(n.name || ''))
    if (field) {
      await dispatch('fillInput', [field.ref, 'typed-by-agent'])
      const readBack = await dispatch('js', ['document.getElementById("probe-input").value'])
      report.filledValue = readBack
    }

    // ── 跨运行：换一个派发器，拿上一轮的 ref 说话 ─────────────────────────
    // 先在页面**最前面**插一个元素，把所有 @eN 整体推后一位。这一步是这条判据的全部分量所在：
    // 不推的话，一个完全没实现账本、只是按编号在新快照里撞的实现也会绿。推了之后，按编号解会
    // 落到隔壁那个元素上，只有按内容认才还能找回原来那个。
    if (field) {
      await dispatch('js', ["(() => { const b = document.createElement('button'); b.id = 'pushed'; b.textContent = 'Pushed In Front'; document.body.prepend(b); return true })()"])
      // 全新的派发器 = 全新的一次 browser run：它对上面那些快照一无所知，只剩账本。
      const nextRun = createBrowserPageDispatch(contextFor())
      try {
        await nextRun('fillInput', [field.ref, 'across-runs'])
        report.crossRunValue = await nextRun('js', ['document.getElementById("probe-input").value'])
      } catch (error) {
        report.crossRunError = String(error && error.message || error)
      }
      // 自愈是有损的，所以它必须留痕。没留痕的成功与一次干净的成功长得一模一样。
      report.crossRunNoted = (report.healNotes || []).length > 0
    }

    // ── 反向判据：三类失败各自被认出来，且互不折并 ───────────────────────
    // 「没报错」绝不等于「对」：页面变了之后旧 ref 的 backendNodeId 往往仍然解得开。
    async function refuse(label, run) {
      try {
        await run()
        return label + ':resolved-anyway'
      } catch (error) {
        return String(error && error.message || error)
      }
    }

    report.unknownRefMessage = await refuse('unknown', () => dispatch('click', ['@e9999']))

    navigationId = 'nav-2'
    report.staleSnapshotMessage = await refuse('stale', () => dispatch('click', [target.ref]))
    navigationId = 'nav-1'

    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = String(error && error.stack || error)
  } finally {
    try {
      if (session) session.detach()
      report.detachedCleanly = !view.webContents.isDestroyed() && !view.webContents.debugger.isAttached()
    } catch (cleanupError) {
      report.detachError = String(cleanupError && cleanupError.message || cleanupError)
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    app.exit(0)
  }
})
`

/** 探针要加载的那个 bundle 的入口。它只 re-export，真正的代码全在 src 里。 */
const BUNDLE_ENTRY = `
export { createBrowserPageDispatch } from '${new URL('browser-page-dispatch.ts', SRC_MAIN).pathname}'
export { BrowserCdpSession } from '${new URL('browser-cdp-session.ts', SRC_MAIN).pathname}'
`

/**
 * 把生产源码打成探针能 import 的一个 ESM 文件。
 *
 * 为什么不直接用 `out/main/index.js`：那是整个主进程的 bundle，import 它会把 app 启动一遍。
 * 为什么不 import 单个 `.js`：产物是 bundle，源文件在里面不再是独立模块（正因如此，接线之前
 * 那两个模块被 tree-shake 掉了——`grep -c captureBrowserPageSnapshot out/main/index.js` 是 0）。
 *
 * 这里从 **src 真身**打，不抄一份。整条依赖链没有运行时依赖（electron 只被 type-only import），
 * 所以打出来的就是那几个模块本身。
 */
async function buildDispatchBundle(outDirectory: string): Promise<void> {
  const { build } = await import('vite')
  const entryPath = join(outDirectory, 'entry.ts')
  await writeFile(entryPath, BUNDLE_ENTRY)
  await build({
    logLevel: 'error',
    build: {
      outDir: outDirectory,
      emptyOutDir: false,
      lib: { entry: entryPath, formats: ['es'], fileName: () => 'dispatch.mjs' },
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
}

const temporaryRoots: string[] = []

afterAll(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

type ProbeReport = {
  ok?: boolean
  error?: string
  loadedProductionModules?: boolean
  attached?: boolean
  firstNodeCount?: number
  firstRefs?: string[]
  firstMissingFrames?: number
  targetRef?: string | null
  clickDispatched?: boolean
  secondNodeCount?: number
  secondRefs?: string[]
  revealedAppeared?: boolean
  textMentionsRef?: boolean
  filledValue?: unknown
  unknownRefMessage?: string
  staleSnapshotMessage?: string
  /** 换一次运行之后，拿上一轮的 ref 填进去的那个值；认错了元素就读不回它。 */
  crossRunValue?: unknown
  crossRunError?: string
  /** 自愈留痕了没有。认回来是按外观匹配的，不留痕等于把有损的当成干净的。 */
  crossRunNoted?: boolean
  healNotes?: string[]
  detachedCleanly?: boolean
  detachError?: string
}

async function runProbe(): Promise<ProbeReport> {
  const root = await mkdtemp(join(tmpdir(), 'amux-drive-e2e-'))
  temporaryRoots.push(root)
  const pagePath = join(root, 'probe.html')
  const reportPath = join(root, 'report.json')
  await buildDispatchBundle(root)
  await writeFile(join(root, 'main.mjs'), PROBE_MAIN)
  await writeFile(pagePath, PROBE_PAGE)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'drive-e2e', type: 'module', main: 'main.mjs' }))

  const child = spawn(ELECTRON_BINARY, [root], {
    env: {
      ...process.env,
      PROBE_REPORT: reportPath,
      PROBE_PAGE_URL: `file://${pagePath}`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('drive e2e probe timed out')) }, 90_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })

  const raw = await readFile(reportPath, 'utf8').catch(() => null)
  if (raw === null) {
    // 报告缺席**不等于**闭环不成立——探针自己没起来也长这样（main 写成 CJS、bundle 没打出来、
    // Electron 二进制不在）。把 stderr 原样带上，让这两类一眼可分；否则脚手架的毛病会被读成
    // 产品的结论，而那个方向的误判最贵：它会让人去改一段本来是对的代码。
    throw new Error(
      `drive e2e probe published no report (exit=${exitCode}) — the probe itself failed to run, ` +
        `which is NOT the same as the vertical slice failing. Electron stderr:\n${stderr.slice(-2000)}`
    )
  }
  return JSON.parse(raw) as ProbeReport
}

// 一次真机运行，多条断言读同一份报告：起 Electron + 打 bundle 是秒级开销，每条断言各起一次是白等。
let report: ProbeReport | undefined
async function probe(): Promise<ProbeReport> {
  report ??= await runProbe()
  return report
}

describe('T-010 真机竖切：snapshot → click(ref) → re-snapshot', () => {
  it('探针加载到了生产模块，且真机上接上了 CDP', async () => {
    const result = await probe()
    // 这一条是其余所有断言的前提：没加载到生产模块，下面测的就是别的东西。
    expect(result.error, `探针自己抛了：${result.error}`).toBeUndefined()
    expect(result.loadedProductionModules, '从 src 打的 bundle 没加载起来——本条测的不是生产代码').toBe(true)
    expect(result.attached, '真实 WebContentsView 上没接上 CDP').toBe(true)
    expect(result.ok).toBe(true)
  }, 180_000)

  it('第一张快照在真页面上有收获，且带得出可点的 ref', async () => {
    const result = await probe()
    // 「扫到有收获」而不是「没抛错」：空树是第三种白绿（AGENTS.md:85-88）。
    expect(result.firstNodeCount ?? 0, '快照是空的——snapshot 在真页面上没收获').toBeGreaterThan(0)
    expect(result.firstRefs ?? [], '一个带 ref 的节点都没有——按 ref 驱动无从谈起').not.toHaveLength(0)
    expect(result.targetRef, 'snapshot 里认不出那个按钮').toBeTruthy()
  }, 180_000)

  it('ref 解得开并派发出去，页面因此真的变了', async () => {
    const result = await probe()
    expect(result.clickDispatched, '动作没派发出去').toBe(true)
    // 闭环的最后一步，也是 T-001 那条没有覆盖的那一步。判据取「出现一个此前不存在的节点」
    // 而不是「文本变了」——后者对一个直接返回上一张快照的实现失明。
    expect(result.revealedAppeared, 're-snapshot 没看到点击后出现的新节点——闭环没有闭上').toBe(true)
    expect(result.secondRefs ?? [], '第二张快照是空的').not.toHaveLength(0)
    expect(result.firstRefs ?? []).not.toEqual(result.secondRefs ?? [])
  }, 180_000)

  it('Agent 读到的那份文本带着把手，填输入框真的落到了页面上', async () => {
    const result = await probe()
    expect(result.textMentionsRef, 'snapshotText 里没有 ref——Agent 读完无从下手').toBe(true)
    // 读回来的是页面上的真值，不是我们自己刚写进去的那个变量：只设 value 不派事件的实现
    // 在这条上会绿，所以它证的是"值到了"，配合受控输入才有意义——这里先钉住"值到了"。
    expect(result.filledValue, 'fillInput 没把值落到页面上').toBe('typed-by-agent')
  }, 180_000)

  it('两类 ref 失败各自说清了下一步，且不是同一句话', async () => {
    const result = await probe()
    // 「没报错」绝不等于「对」：页面变了之后旧 ref 的 backendNodeId 往往仍然解得开。
    expect(result.unknownRefMessage, '编造的 ref 被放行了').not.toMatch(/resolved-anyway/)
    expect(result.unknownRefMessage, '没说清这个 ref 不在快照里').toMatch(/snapshot/i)
    expect(result.staleSnapshotMessage, 'navigationId 对不上却照样放行——Agent 会拿旧地图点新页面')
      .not.toMatch(/resolved-anyway/)
    expect(result.staleSnapshotMessage, '没说清页面已经导航过了').toMatch(/navigat/i)
    // 折并成一句话，Agent 就分不清"该重取快照"与"我把手拼错了"。
    expect(result.staleSnapshotMessage, '两类失败被折并成同一句话').not.toBe(result.unknownRefMessage)
  }, 180_000)

  it('换一次运行、页面重排之后，上一轮的 ref 仍然落在同一个元素上（T-011）', async () => {
    const result = await probe()
    // 这条在真页面上判 T-011 的实质。探针在页面最前面插了一个元素，于是所有 @eN 整体推后一位：
    // 按编号解会落到隔壁，只有按内容认才还能找回原来那个输入框。
    expect(result.crossRunError, `跨运行的 ref 没认回来：${result.crossRunError}`).toBeUndefined()
    expect(result.crossRunValue, '换一次运行之后，同一个 ref 落到了别的元素上——或者根本没落到任何元素上')
      .toBe('across-runs')
    // 认回来是按外观匹配的，可能命中一个长得一样的邻居。留痕是这件事唯一的补救。
    expect(result.crossRunNoted, '自愈了却一声不响——Agent 会把一次按外观的匹配当成干净的成功').toBe(true)
  }, 180_000)

  it('用完把 debugger 摘干净', async () => {
    const result = await probe()
    // 不摘的话，用户此后再也打不开这个页面的 DevTools（Electron 两者互斥），而且是静默的。
    expect(result.detachError, `detach 失败：${result.detachError}`).toBeUndefined()
    expect(result.detachedCleanly, 'detach 之后 debugger 仍然挂着').toBe(true)
  }, 180_000)
})

describe('T-010 零调用者：这条路在生产里真有人走', () => {
  /**
   * 任务验收原话：「按该节给的 grep 形状搜索符号并排除定义文件本身——命中全在定义文件内即为
   * 竖切未闭合，如实标 blocked 不得蒙混。」这里把那条 grep 变成判据本身。
   *
   * 只扫 `src/`，**不扫 `test/`**：测试里的调用正是这条判据要排除的东西——那个陷阱的形状
   * 就是"只有测试在调"。
   */
  function productionCallers(symbol: string, definedIn: string): string[] {
    const directory = new URL('../src/main/', import.meta.url)
    const hits: string[] = []
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts') || name === definedIn) continue
      if (readFileSync(new URL(name, directory), 'utf8').includes(symbol)) hits.push(name)
    }
    return hits
  }

  it('快照与 ref 解析在生产代码里有调用者，不是只有测试在 import', () => {
    // 先证扫描面非空：目录读错时下面两条会各拿一个空集，恒真。
    const files = readdirSync(new URL('../src/main/', import.meta.url)).filter((n) => n.endsWith('.ts'))
    expect(files.length, 'src/main 扫出来是空的——这条判据在对空气生效').toBeGreaterThan(20)

    expect(
      productionCallers('captureBrowserPageSnapshot', 'browser-page-snapshot.ts'),
      '快照模块在生产代码里零调用者——竖切没闭合，只有测试在 import'
    ).not.toHaveLength(0)
    expect(
      productionCallers('resolveBrowserRef', 'browser-ref-resolve.ts'),
      'ref 解析在生产代码里零调用者——竖切没闭合，只有测试在 import'
    ).not.toHaveLength(0)
  })

  it('派发层被 BrowserViewManager 真的接进了 runScript 那条路', () => {
    const manager = readFileSync(new URL('../src/main/browser-view-manager.ts', import.meta.url), 'utf8')
    // 在场不等于可达：import 了却没人调，与没 import 一样是死代码。
    expect(manager, '派发层没被 import').toContain('createBrowserPageDispatch')
    expect(manager, 'import 了却没调用——在场不等于可达').toMatch(/createBrowserPageDispatch\(/)
    expect(manager, 'CDP 会话没接上').toMatch(/BrowserCdpSession\.attach\(/)
    // detach 漏掉的后果是静默的：用户此后再也打不开这个页面的 DevTools。
    expect(manager, 'detach 不在 finally 里——失败路径上会把用户的 DevTools 永久占住')
      .toMatch(/finally\s*\{[^}]*detach\(\)/)
  })
})
