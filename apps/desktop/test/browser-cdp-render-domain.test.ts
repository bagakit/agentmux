import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * T-001 证伪：依赖渲染的 CDP 域在真实 `WebContentsView` 上到底能不能用。
 *
 * 为什么必须起真 Electron，而不是像 browser-view-manager.test.ts 那样 `vi.mock('electron')`：
 * 本任务要判定的**恰恰是** Electron 真实实现的行为。假 WebContentsView 想让 getFullAXTree 返回
 * 什么就返回什么，用它跑出来的绿是自证（见 MEMORY「合成的 fixture 等于自证」）。
 *
 * 也不能退回 `show: false` 的 BrowserWindow——那正是 browser-profile-manager.ts:205 已跑通的场景，
 * 而它只用了 Network 域。Accessibility/DOM 是**渲染域**，要求有真实渲染中的帧；隐藏窗口上的绿
 * 对可见 WebContentsView 不构成证据。这条区分就是本任务存在的全部理由。
 */

/**
 * 二进制路径从 `electron` 包自己导出的那个值取，不手抄。
 * 手抄一条含版本号的 `.pnpm/electron@43.3.0/...` 路径，会在下一次 Electron 升级时静默失效——
 * 而它失效的样子是 ENOENT 三条全红，看起来像「渲染域不可用」，正好是本任务要判定的那个结论。
 * 判据必须不能被环境噪声伪造成阴性（见 MEMORY「构建图之外的手抄常量」）。
 */
const ELECTRON_BINARY: string = createRequire(import.meta.url)('electron') as unknown as string

/**
 * 探针页要同时含 button 与 link：T-001 的验收要求 AX 树里「至少含一个 role 为 button 或 link
 * 的节点」。两种都放，是为了让判定不依赖 Chromium 对某一种角色的具体命名。
 */
const PROBE_PAGE = `<!doctype html><html><body>
  <button id="probe-button">Probe Button</button>
  <a id="probe-link" href="https://example.invalid/">Probe Link</a>
</body></html>`

/**
 * 在主进程里跑的探针。结论写进 JSON 报告文件——stdout 在 Electron 上混着 GPU/沙箱噪声，
 * 用文件是本仓既有做法（file-editing-probe.ts:133 publishReport 同形状）。
 */
const PROBE_MAIN = `
const { app, BrowserWindow, WebContentsView } = require('electron')
const { writeFileSync } = require('node:fs')

const reportPath = process.env.PROBE_REPORT
const pageUrl = process.env.PROBE_PAGE_URL
const report = { schema: 'agentmux.browser-cdp-render-domain.v1' }

function publish() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
}

app.whenReady().then(async () => {
  // 真实可见窗口 + 真实 WebContentsView，不是 show:false。渲染域要有真实渲染中的帧。
  const window = new BrowserWindow({ width: 900, height: 700, show: true })
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 })

  let attached = false
  try {
    await view.webContents.loadURL(pageUrl)
    // 等一帧真的画出来——渲染域的可用性前提就是这个。
    await new Promise((resolve) => {
      if (view.webContents.isLoadingMainFrame()) view.webContents.once('did-stop-loading', resolve)
      else resolve(undefined)
    })

    // attach 参数照 browser-profile-manager.ts:220 的既有写法：不传 version 参数。
    view.webContents.debugger.attach()
    attached = true

    await view.webContents.debugger.sendCommand('Accessibility.enable')
    const axTree = await view.webContents.debugger.sendCommand('Accessibility.getFullAXTree')
    const nodes = Array.isArray(axTree?.nodes) ? axTree.nodes : []
    report.axNodeCount = nodes.length
    // 「扫到有收获」而不是「没抛错」：记下真正找到的角色名，供测试侧断言非空。
    report.axRoles = [...new Set(nodes.map((n) => n?.role?.value).filter(Boolean))]
    report.axInteractiveRoles = report.axRoles.filter((r) => r === 'button' || r === 'link')
    report.axNames = nodes.map((n) => n?.name?.value).filter(Boolean)

    // DOM.resolveNode：决定 T-005 的 ref→objectId 点击路径是否成立。
    await view.webContents.debugger.sendCommand('DOM.enable')
    const doc = await view.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1 })
    const backendNodeId = nodes
      .map((n) => n?.backendDOMNodeId)
      .find((id) => typeof id === 'number' && id > 0)
    report.documentPresent = Boolean(doc?.root?.nodeId)
    report.backendNodeIdFound = backendNodeId ?? null
    if (backendNodeId !== undefined) {
      const resolved = await view.webContents.debugger.sendCommand('DOM.resolveNode', { backendNodeId })
      report.resolvedObjectId = resolved?.object?.objectId ?? null
    }

    // OOPIF 结论单独记录：拿不到不阻塞本任务，但 T-004 设计 outcome 分类要用。
    // 参数照 ~/proj/github/ego-lite/.../browser-runtime.ts:19-22 的 OOPIF_AUTO_ATTACH_PARAMS。
    try {
      await view.webContents.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true
      })
      report.oopifAutoAttach = 'accepted'
    } catch (error) {
      report.oopifAutoAttach = 'rejected: ' + String(error && error.message || error)
    }

    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = String(error && error.stack || error)
  } finally {
    // detach 照 browser-profile-manager.ts:237-238 的既有清理形状。
    try {
      if (attached && view.webContents.debugger.isAttached()) view.webContents.debugger.detach()
    } catch (cleanupError) {
      report.detachError = String(cleanupError && cleanupError.message || cleanupError)
    }
    publish()
    app.exit(0)
  }
})
`

const temporaryRoots: string[] = []

afterAll(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

type ProbeReport = {
  ok?: boolean
  error?: string
  axNodeCount?: number
  axRoles?: string[]
  axInteractiveRoles?: string[]
  axNames?: string[]
  documentPresent?: boolean
  backendNodeIdFound?: number | null
  resolvedObjectId?: string | null
  oopifAutoAttach?: string
  detachError?: string
}

async function runProbe(): Promise<ProbeReport> {
  const root = await mkdtemp(join(tmpdir(), 'amux-cdp-probe-'))
  temporaryRoots.push(root)
  const mainPath = join(root, 'main.cjs')
  const pagePath = join(root, 'probe.html')
  const reportPath = join(root, 'report.json')
  await writeFile(mainPath, PROBE_MAIN)
  await writeFile(pagePath, PROBE_PAGE)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cdp-probe', main: 'main.cjs' }))

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
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CDP probe timed out')) }, 90_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })

  const raw = await readFile(reportPath, 'utf8').catch(() => null)
  if (raw === null) {
    throw new Error(`CDP probe published no report (exit=${exitCode}); stderr:\n${stderr.slice(-2000)}`)
  }
  return JSON.parse(raw) as ProbeReport
}

// 一次真机运行，多条断言读同一份报告：起 Electron 是秒级开销，每条断言各起一次是白等。
let report: ProbeReport | undefined
async function probe(): Promise<ProbeReport> {
  report ??= await runProbe()
  return report
}

describe('CDP render-dependent domains on a real WebContentsView', () => {
  it('attaches the debugger to a visible WebContentsView at all', async () => {
    const result = await probe()
    expect(result.error, '探针自己抛了——渲染域可用性无从判定').toBeUndefined()
    expect(result.ok).toBe(true)
  }, 120_000)

  it('returns a non-empty AX tree that actually contains interactive roles', async () => {
    const result = await probe()
    // 「扫到有收获」而不是「没抛错」：空树是第三种白绿（AGENTS.md:85-88）。
    expect(result.axNodeCount ?? 0, 'AX 树是空的——getFullAXTree 在 WebContentsView 上没有收获').toBeGreaterThan(0)
    expect(result.axInteractiveRoles ?? [], 'AX 树里没有 button/link——扫到的不是真页面语义')
      .not.toHaveLength(0)
    // 名字也要扫到：只有 role 没有 name 的树对 T-004 的 {ref,role,name} 契约不够用。
    expect(result.axNames ?? [], 'AX 节点全都没有 name——快照契约的第三个字段拿不到').not.toHaveLength(0)
  }, 120_000)

  it('resolves a backendNodeId into an objectId, which T-005 click path needs', async () => {
    const result = await probe()
    expect(result.documentPresent, 'DOM.getDocument 没有 root').toBe(true)
    expect(result.backendNodeIdFound, 'AX 节点上没有 backendDOMNodeId——ref 身份键缺一半').toBeTruthy()
    expect(result.resolvedObjectId, 'DOM.resolveNode 没解出 objectId——按 ref 派发动作不成立').toBeTruthy()
  }, 120_000)
})
