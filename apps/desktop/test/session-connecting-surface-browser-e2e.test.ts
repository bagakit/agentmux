import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * This is the browser proof for the connecting surface.  The renderer is built from the production
 * `SessionConnectingSurface` and `session-connecting.css` modules below; the probe does not contain a
 * second copy of the JSX or its styles.  A real Electron `WebContentsView` then supplies the viewport,
 * CSS container queries, media feature, and layout engine that happy-dom cannot provide.
 */
const ELECTRON_BINARY: string = createRequire(import.meta.url)('electron') as unknown as string
const SRC_RENDERER = new URL('../src/renderer/src/', import.meta.url)

const PROMPT = 'Inspect the launch surface at a narrow width.\nKeep this complete prompt readable and copyable.'

const BUNDLE_ENTRY = `
import { createRoot } from 'react-dom/client'
import React from 'react'
import { SessionConnectingSurface } from '${new URL('components/SessionConnectingSurface.tsx', SRC_RENDERER).pathname}'
import '${new URL('styles/index.css', SRC_RENDERER).pathname}'

const root = document.getElementById('root')
if (!root) throw new Error('connecting surface probe root is missing')

createRoot(root).render(
  <SessionConnectingSurface
    phase="restore"
    surfaceKind="agent"
    request={{ executorId: 'codex', prompt: ${JSON.stringify(PROMPT)} }}
    executor={{ label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }}
    appearance={{ tint: '#8de3ae', badge: 'spark' }}
  />
)
`

const PROBE_MAIN = `
import { app, BrowserWindow, WebContentsView } from 'electron'
import { writeFileSync } from 'node:fs'

const reportPath = process.env.PROBE_REPORT
const pageUrl = process.env.PROBE_PAGE_URL
const report = { schema: 'agentmux.session-connecting-surface-browser-e2e.v1', cases: [] }

function waitForSurface(view) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 12_000
    const tick = async () => {
      try {
        const present = await view.webContents.executeJavaScript(
          'Boolean(document.querySelector(".session-connecting__heading h2"))', true
        )
        if (present) return resolve(undefined)
      } catch (error) {
        return reject(error)
      }
      if (Date.now() >= deadline) {
        const body = await view.webContents.executeJavaScript('document.documentElement?.outerHTML?.slice(0, 2000)', true).catch((error) => String(error))
        return reject(new Error('SessionConnectingSurface did not mount; body=' + body))
      }
      setTimeout(tick, 20)
    }
    tick()
  })
}

async function inspect(view) {
  await waitForSurface(view)
  return await view.webContents.executeJavaScript(
    '(async () => { await document.fonts?.ready; const surface = document.querySelector(".session-connecting"); const body = document.querySelector(".session-connecting__body"); const heading = document.querySelector(".session-connecting__heading h2"); const prompt = document.querySelector(".session-connecting__prompt pre"); const stage = document.querySelector(".full-page-loading__stage"); const slices = [...document.querySelectorAll(".full-page-loading__signal span, .full-page-loading__signal i")]; const css = getComputedStyle(surface); const bodyRect = body.getBoundingClientRect(); const headingRect = heading.getBoundingClientRect(); const promptRect = prompt.getBoundingClientRect(); return { innerWidth: innerWidth, innerHeight: innerHeight, surfaceRect: surface.getBoundingClientRect().toJSON(), bodyRect: bodyRect.toJSON(), headingRect: headingRect.toJSON(), promptRect: promptRect.toJSON(), surfaceClientWidth: surface.clientWidth, surfaceScrollWidth: surface.scrollWidth, bodyScrollWidth: body.scrollWidth, promptClientWidth: prompt.clientWidth, promptScrollWidth: prompt.scrollWidth, paddingInline: getComputedStyle(stage).paddingInline, signalCount: document.querySelectorAll(".full-page-loading__signal, .session-connecting__signal").length, eyebrowTexts: [...document.querySelectorAll(".full-page-loading__eyebrow, .session-connecting__eyebrow")].map((node) => node.textContent),  overflowX: css.overflowX, headingText: heading.textContent, promptText: prompt.textContent, sliceAnimationNames: slices.map((node) => getComputedStyle(node).animationName), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, bodyVisible: bodyRect.width > 0 && bodyRect.height > 0, headingVisible: headingRect.width > 0 && headingRect.height > 0, promptVisible: promptRect.width > 0 && promptRect.height > 0 }; })()', true
  )
}

async function setReducedMotion(view, reduced) {
  view.webContents.debugger.attach('1.3')
  await view.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]
  })
}

async function runCase(window, width, reducedMotion) {
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width, height: 680 })
  view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    report.console = [...(report.console || []), { level, message, line, sourceId }]
  })
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    report.loadError = { errorCode, errorDescription, validatedURL }
  })
  try {
    await view.webContents.loadURL(pageUrl)
    await setReducedMotion(view, reducedMotion)
    const result = await inspect(view)
    return { width, reducedMotion, result }
  } finally {
    try { if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach() } catch {}
    try { window.contentView.removeChildView(view) } catch {}
    try { view.webContents.close() } catch {}
  }
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 420, height: 680, show: false })
  try {
    report.cases.push(await runCase(window, 320, false))
    report.cases.push(await runCase(window, 420, false))
    report.cases.push(await runCase(window, 420, true))
    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = String(error && error.stack || error) + ' diagnostics=' + JSON.stringify({ console: report.console, loadError: report.loadError })
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    window.destroy()
    app.exit(0)
  }
})
`

type SurfaceCase = {
  width: number
  reducedMotion: boolean
  result: {
    innerWidth: number
    surfaceRect: { width: number; height: number }
    bodyRect: { width: number; height: number }
    headingRect: { width: number; height: number }
    promptRect: { width: number; height: number }
    surfaceClientWidth: number
    surfaceScrollWidth: number
    bodyScrollWidth: number
    promptClientWidth: number
    promptScrollWidth: number
    paddingInline: string
    signalCount: number
    eyebrowTexts: string[]
    overflowX: string
    headingText: string
    promptText: string
    sliceAnimationNames: string[]
    reducedMotion: boolean
    bodyVisible: boolean
    headingVisible: boolean
    promptVisible: boolean
  }
}

type ProbeReport = { ok?: boolean; error?: string; cases: SurfaceCase[] }

async function buildRendererBundle(outDirectory: string): Promise<void> {
  const { build } = await import('vite')
  const entryPath = join(outDirectory, 'entry.tsx')
  await writeFile(entryPath, BUNDLE_ENTRY)
  await build({
    logLevel: 'error',
    root: new URL('../', import.meta.url).pathname,
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'browser-proof-react-classic-import',
        enforce: 'pre' as const,
        transform(code: string, id: string) {
          return id.endsWith('.tsx') && id.includes('/src/renderer/src/')
            ? { code: "import React from 'react'\n" + code, map: null }
            : undefined
        }
      },
      (await import('@vitejs/plugin-react')).default({ jsxRuntime: 'classic' })
    ],
    resolve: {
      // The temporary Vite entry lives outside the workspace, so its bare React imports do not have a
      // node_modules ancestor.  Keep them pointed at the same package the desktop renderer uses.
      alias: {
        react: new URL('../node_modules/react', import.meta.url).pathname,
        'react-dom': new URL('../node_modules/react-dom', import.meta.url).pathname,
        'lucide-react': new URL('../node_modules/lucide-react', import.meta.url).pathname
      }
    },
    build: {
      outDir: outDirectory,
      emptyOutDir: false,
      lib: { entry: entryPath, formats: ['es'], fileName: () => 'renderer.mjs' }
    }
  })
}

const temporaryRoots: string[] = []
afterAll(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

let report: ProbeReport | undefined
async function probe(): Promise<ProbeReport> {
  if (report) return report
  const root = await mkdtemp(join(tmpdir(), 'amux-connecting-surface-e2e-'))
  temporaryRoots.push(root)
  await buildRendererBundle(root)
  await writeFile(join(root, 'main.mjs'), PROBE_MAIN)
  const cssFile = (await readdir(root)).find((name) => name.endsWith('.css'))
  if (!cssFile) throw new Error('Vite production bundle did not emit CSS for SessionConnectingSurface')
  await writeFile(join(root, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="./${cssFile}"></head><body><div id="root"></div><script type="module" src="./renderer.mjs"></script></body></html>`)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'connecting-surface-e2e', type: 'module', main: 'main.mjs' }))
  const reportPath = join(root, 'report.json')
  const child = spawn(ELECTRON_BINARY, [root], {
    env: { ...process.env, PROBE_REPORT: reportPath, PROBE_PAGE_URL: `file://${join(root, 'index.html')}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('connecting surface browser probe timed out')) }, 120_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
  const raw = await readFile(reportPath, 'utf8').catch(() => null)
  if (!raw) throw new Error(`connecting surface probe published no report (exit=${exitCode}). Electron stderr:\n${stderr.slice(-3000)}`)
  report = JSON.parse(raw) as ProbeReport
  return report
}

describe('SessionConnectingSurface in a real Electron WebContentsView', () => {
  it('loads the production bundle and captures all requested viewports', async () => {
    const result = await probe()
    expect(result.error, `probe failed: ${result.error}`).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.cases).toHaveLength(3)
  }, 180_000)

  // 内边距量的是 `.full-page-loading__stage`——这张面被搬进 `FullPageLoadingSurface` 之后，
  // 舞台的留白归它。两档宽度下都是 `var(--sp-6)` = 16px（`__stage` 的 `padding: var(--sp-8) var(--sp-6)`）。
  //
  // 这两条判据此前期望 16px / 21px，那是 `.session-connecting` 还自带 `clamp(…, 5vw, …)` 时的
  // 值（5% × 320 = 16，5% × 420 = 21）。搬家之后那条规则连同它的整座舞台都失效了，两处都量到
  // `0px`——**红得对**。修的是源头（删掉那套已经有人画的舞台），不是把期望值改成 0。
  it.each([320, 420])('keeps the %dpx region readable without horizontal overflow', async (width) => {
    const result = await probe()
    const item = result.cases.find((candidate) => candidate.width === width && !candidate.reducedMotion)
    expect(item, `missing ${width}px case`).toBeDefined()
    const view = item!.result
    expect(view.innerWidth).toBe(width)
    expect(view.surfaceRect.width).toBe(width)
    expect(view.bodyVisible).toBe(true)
    expect(view.headingVisible).toBe(true)
    expect(view.promptVisible).toBe(true)
    expect(view.paddingInline, '舞台没有横向留白——文字贴到了 Region 边缘').toBe('16px')
    expect(view.surfaceScrollWidth).toBe(view.surfaceClientWidth)
    expect(view.bodyScrollWidth).toBeLessThanOrEqual(view.surfaceClientWidth)
    expect(view.promptScrollWidth).toBe(view.promptClientWidth)
    expect(view.headingText).toContain('Restoring your session')
    expect(view.promptText).toBe(PROMPT)
  }, 180_000)

  // 设计 SSOT「全页加载大屏」：调用方不重复实现全屏 spinner 或品牌 splash。
  // 这条守的是那句话被违反时**屏幕上**的样子：两组扫描切片、两行「Session connection」。
  // 它曾经真的发生过——这张面搬进 `FullPageLoadingSurface` 时带着自己那份 signal 与 eyebrow
  // 一起搬了进去，而圈着旧舞台的 `:not(.full-page-loading)` 从此一条都不命中，于是旧的那份
  // 没有被样式藏起来，两份同时显形。类型检查、单测和 review 都看不见这件事。
  it('不重复画大屏的 chrome——同一张面上只有一组信号和一行阶段标签', async () => {
    const result = await probe()
    expect(result.cases.length).toBeGreaterThan(0)
    for (const item of result.cases) {
      const view = item.result
      expect(view.signalCount, `${item.width}px 上有 ${view.signalCount} 组扫描切片`).toBe(1)
      // 钉死整张清单而不是数个数：`Executor` 与 `Initial prompt` 是这张面自己的小标签，
      // 该在；重复的是阶段行。整份写出来，多一行少一行都当场看得见是哪一行。
      expect(view.eyebrowTexts).toEqual(['Session connection', 'Executor', 'Initial prompt'])
    }
  }, 180_000)

  it('keeps the connecting identity and prompt intact when reduced motion is requested', async () => {
    const result = await probe()
    const item = result.cases.find((candidate) => candidate.reducedMotion)
    expect(item).toBeDefined()
    const view = item!.result
    expect(view.reducedMotion).toBe(true)
    expect(view.headingText).toContain('Restoring your session')
    expect(view.promptText).toBe(PROMPT)
    // 钉死整份清单：空集合上 `.every()` 恒真，而「一个都没扫到」正是这次缺陷的形态。
    expect(view.sliceAnimationNames).toEqual(['none', 'none', 'none', 'none'])
    expect(view.surfaceScrollWidth).toBe(view.surfaceClientWidth)
    expect(view.bodyVisible).toBe(true)
    expect(view.headingVisible).toBe(true)
    expect(view.promptVisible).toBe(true)
  }, 180_000)
})
