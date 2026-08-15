import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * T-012 的地基判据：**Agent 自己的动作不产生 `input-event`**。
 *
 * 整个「人抢回方向盘」的设计押在这一条上。驱动路只用 `Accessibility.*` / `DOM.*` / `Runtime.*`
 * 三个 CDP 域，动作是页面内 JS 的 `this.click()` / `dispatchEvent(...)`——脚本发起的 DOM 事件，
 * 不走原生输入管线。如果这一条不成立，`input-event` 就不是「真人碰过」的信号，而是「有人动过」，
 * 于是 Agent 每点一下就把自己判成被接管，功能当场变成噪音。
 *
 * 这一条**只能在真机上判**：假的 webContents 想不发什么就不发什么，用它跑出来的绿是自证。
 *
 * 反向的一半同样承重：`sendInputEvent` 之后**必须**收到事件。少了它，「Agent 动作零事件」与
 * 「监听器根本没挂上」长得一模一样，而后者会让整份实现静默失效（MEMORY「长命观察者建立后
 * 死亡是静默的」是同一族）。
 *
 * `sendInputEvent` 不是真人的手，但它进的是同一个原生输入入口——这是本机能构造的最接近的东西。
 */

const ELECTRON_BINARY: string = createRequire(import.meta.url)('electron') as unknown as string
const SRC_MAIN = new URL('../src/main/', import.meta.url)

const PROBE_PAGE = `<!doctype html><html><body style="margin:0">
  <button id="probe-button" style="position:absolute;left:0;top:0;width:400px;height:200px">Reveal</button>
  <input id="probe-input" aria-label="Probe Field" />
</body></html>`

const PROBE_MAIN = `
import { app, BrowserWindow, WebContentsView } from 'electron'
import { writeFileSync } from 'node:fs'

const reportPath = process.env.PROBE_REPORT
const pageUrl = process.env.PROBE_PAGE_URL
const report = { schema: 'agentmux.browser-ownership.v1' }

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 900, height: 700, show: true })
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 })

  let session = null
  try {
    const {
      createBrowserPageDispatch,
      BrowserCdpSession,
      BROWSER_SELECTION_WORLD_ID,
      buildBrowserDriveBadgeScript,
      buildCancelBrowserDriveBadgeScript,
      BROWSER_DRIVE_BADGE_ATTRIBUTE
    } = await import('./dispatch.mjs')
    report.loadedProductionModules = true

    await view.webContents.loadURL(pageUrl)
    await new Promise((resolve) => {
      if (view.webContents.isLoadingMainFrame()) view.webContents.once('did-stop-loading', resolve)
      else resolve(undefined)
    })

    // 监听器在 Agent 动手**之前**就挂上：晚挂等于把"没收到"变成"没在听"。
    const seen = []
    view.webContents.on('input-event', (_event, input) => { seen.push(input.type) })

    session = BrowserCdpSession.attach(view.webContents)
    let ledger = null
    const dispatch = createBrowserPageDispatch({
      session,
      pageInfo: () => ({ url: view.webContents.getURL(), title: view.webContents.getTitle(), navigationId: 'nav-1' }),
      gotoUrl: async () => { throw new Error('the probe does not navigate') },
      captureScreenshot: async () => ({ stub: true }),
      readLedger: async () => ledger,
      writeLedger: async (next) => { ledger = next },
      note: () => {}
    })

    const snapshot = await dispatch('snapshot', [])
    const button = snapshot.nodes.find((n) => n.ref && /reveal/i.test(n.name || ''))
    const field = snapshot.nodes.find((n) => n.ref && /probe field/i.test(n.name || ''))
    if (!button || !field) throw new Error('探针页的两个元素没在快照里——下面测的就是别的东西')

    // Agent 能做的每一类动作都走一遍。只跑 click 的话，"fillInput 的 focus() 会不会发事件"
    // 这一类问题就没被问过。
    await dispatch('click', [button.ref])
    await dispatch('fillInput', [field.ref, 'typed-by-agent'])
    await dispatch('typeText', [field.ref, '-more'])
    await dispatch('pressKey', [field.ref, 'Enter'])
    await dispatch('hover', [button.ref])
    await dispatch('scroll', [button.ref])
    // 事件是异步派上来的，紧接着读等于读了个空。让出几轮事件循环再取。
    await new Promise((resolve) => setTimeout(resolve, 300))
    report.agentEvents = [...seen]

    // ── 不抢焦点：三个会 focus() 的动作，用完都要把光标还回去 ─────────────
    // 三个各判一次，不是判"代码里有还回去的那一段"：只还一处的实现在合并判据下照样绿
    // （MEMORY「守卫按出口数不按条件数」）。
    const focusAfter = async (act) => {
      await dispatch('js', ['document.getElementById("probe-button").focus(); true'])
      await act()
      return await dispatch('js', ['document.activeElement ? document.activeElement.id : null'])
    }
    report.focusAfterFillInput = await focusAfter(() => dispatch('fillInput', [field.ref, 'restore-check']))
    report.focusAfterTypeText = await focusAfter(() => dispatch('typeText', [field.ref, '!']))
    report.focusAfterPressKey = await focusAfter(() => dispatch('pressKey', [field.ref, 'Enter']))
    // 反向的一半：人本来就没在别处时，动作该把焦点留在它动过的元素上，而不是硬 blur 掉。
    await dispatch('js', ['document.activeElement && document.activeElement.blur(); true'])
    await dispatch('fillInput', [field.ref, 'no-previous'])
    report.focusWithNoPrevious = await dispatch('js', ['document.activeElement ? document.activeElement.id : null'])

    // ── 角标：在场，但不吃点击 ──────────────────────────────────────────
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildBrowserDriveBadgeScript() }]
    )
    const probeBadge = (expression) => view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: expression }],
      true
    )
    const hostSelector = '[' + BROWSER_DRIVE_BADGE_ATTRIBUTE + ']'
    report.badgePresent = await probeBadge('!!document.querySelector(' + JSON.stringify(hostSelector) + ')')
    // 真正的判据：角标那一格上的点击落到谁身上。落到角标身上，人伸手的第一次点击就被它吃了——
    // 而那一次点击正是接管信号，于是这个提示会阻止它自己提示的那件事被察觉到。
    report.badgeAtPointIsBadge = await probeBadge(\`(() => {
      const host = document.querySelector(\${JSON.stringify(hostSelector)});
      if (!host) return null;
      const box = host.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === host || (hit ? host.contains(hit) : false);
    })()\`)
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserDriveBadgeScript() }]
    )
    report.badgeGoneAfterCancel = await probeBadge('!document.querySelector(' + JSON.stringify(hostSelector) + ')')

    // 反向的一半：真的往原生输入入口送一下，监听器必须出声。
    view.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 })
    view.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    report.afterSyntheticEvents = [...seen]

    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = String(error && error.stack || error)
  } finally {
    try { if (session) session.detach() } catch (cleanupError) { report.detachError = String(cleanupError) }
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    app.exit(0)
  }
})
`

const BUNDLE_ENTRY = `
export { createBrowserPageDispatch } from '${new URL('browser-page-dispatch.ts', SRC_MAIN).pathname}'
export { BrowserCdpSession } from '${new URL('browser-cdp-session.ts', SRC_MAIN).pathname}'
export {
  BROWSER_SELECTION_WORLD_ID,
  BROWSER_DRIVE_BADGE_ATTRIBUTE,
  buildBrowserDriveBadgeScript,
  buildCancelBrowserDriveBadgeScript
} from '${new URL('browser-selection-script.ts', SRC_MAIN).pathname}'
`

/** 与 browser-drive-e2e.test.ts 同形：从 src 真身打一个探针能 import 的 ESM。 */
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
  agentEvents?: string[]
  afterSyntheticEvents?: string[]
  focusAfterFillInput?: string | null
  focusAfterTypeText?: string | null
  focusAfterPressKey?: string | null
  focusWithNoPrevious?: string | null
  badgePresent?: boolean
  badgeAtPointIsBadge?: boolean | null
  badgeGoneAfterCancel?: boolean
  detachError?: string
}

let cached: ProbeReport | undefined

async function probe(): Promise<ProbeReport> {
  if (cached) return cached
  const root = await mkdtemp(join(tmpdir(), 'amux-ownership-'))
  temporaryRoots.push(root)
  const pagePath = join(root, 'probe.html')
  const reportPath = join(root, 'report.json')
  await buildDispatchBundle(root)
  await writeFile(join(root, 'main.mjs'), PROBE_MAIN)
  await writeFile(pagePath, PROBE_PAGE)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ownership-probe', type: 'module', main: 'main.mjs' }))

  const child = spawn(ELECTRON_BINARY, [root], {
    env: { ...process.env, PROBE_REPORT: reportPath, PROBE_PAGE_URL: `file://${pagePath}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ownership probe timed out')) }, 90_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
  const raw = await readFile(reportPath, 'utf8').catch(() => null)
  if (raw === null) {
    // 报告缺席不等于结论为假——探针自己没起来也长这样。把 stderr 带上让两类一眼可分。
    throw new Error(
      `ownership probe published no report (exit=${exitCode}) — the probe itself failed to run, ` +
        `which is NOT the same as the premise failing. Electron stderr:\n${stderr.slice(-2000)}`
    )
  }
  cached = JSON.parse(raw) as ProbeReport
  return cached
}

describe('T-012 地基：input-event 是一个不可伪造的「真人碰过」信号', () => {
  it('Agent 的六类动作一个 input-event 都不产生', async () => {
    const result = await probe()
    expect(result.error, `探针自己抛了：${result.error}`).toBeUndefined()
    expect(result.loadedProductionModules, '没加载到生产模块——本条测的不是生产代码').toBe(true)
    expect(result.agentEvents, `Agent 的动作发出了原生输入事件：${(result.agentEvents ?? []).join(',')}——` +
      'input-event 就不是"真人碰过"的信号了，整套接管判据要换').toEqual([])
  }, 180_000)

  it('往原生输入入口送一下，监听器出声——否则上一条是「没在听」不是「没发生」', async () => {
    const result = await probe()
    expect(result.afterSyntheticEvents ?? [], '监听器根本没收到过任何事件——上一条的空数组毫无意义')
      .not.toHaveLength(0)
    expect(result.afterSyntheticEvents ?? [], '收到的不是那次按下').toContain('mouseDown')
  }, 180_000)
})

describe('T-012 不抢焦点：动作用完把页面内的光标还回去', () => {
  it('三个会 focus() 的动作都还回去了——分三条判，不是判「有还回去的代码」', async () => {
    const result = await probe()
    // 三条各判一次：合成一条的话，「三处只改了一处」的实现会在另外两处上静默照抢。
    expect(result.focusAfterFillInput, 'fillInput 把人的光标抢走了').toBe('probe-button')
    expect(result.focusAfterTypeText, 'typeText 把人的光标抢走了').toBe('probe-button')
    expect(result.focusAfterPressKey, 'pressKey 把人的光标抢走了').toBe('probe-button')
  }, 180_000)

  it('人本来就没在别处时，焦点留在动过的元素上，不硬 blur', async () => {
    // 反向的一半。少了它，一个「动完一律 blur」的实现会让上面三条全绿——而那会让一段
    // 「填完就按 Enter」的程序在自己填的框上失去焦点，下一步按键落到空处。
    const result = await probe()
    expect(result.focusWithNoPrevious, '没有前任焦点时反而把焦点清掉了').toBe('probe-input')
  }, 180_000)
})

describe('T-012 角标：看得见，但不吃人的第一次点击', () => {
  it('角标注得上、撤得掉', async () => {
    const result = await probe()
    expect(result.badgePresent, '角标没注上——「人能看出来」这一半没实现').toBe(true)
    expect(result.badgeGoneAfterCancel, 'run 结束后角标还赖在页面上').toBe(true)
  }, 180_000)

  it('角标那一格上的点击穿过去，落不到角标身上', async () => {
    const result = await probe()
    // 这是本条存在的全部理由：角标能吃点击的话，它会吃掉人伸手的第一次点击——而那一次点击
    // **正是**接管信号。于是这个提示会阻止它自己提示的那件事被察觉到。
    expect(result.badgeAtPointIsBadge, '角标没找到——判据在对空气生效').not.toBeNull()
    expect(result.badgeAtPointIsBadge, '角标吃掉了那一格上的点击，接管信号永远来不了').toBe(false)
  }, 180_000)
})
