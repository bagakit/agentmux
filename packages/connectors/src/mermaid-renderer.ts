import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import browserEngine from 'puppeteer-core'
import { AgentMuxError, readSessionHistoryImageBytes, SESSION_HISTORY_IMAGE_MAX_DIMENSION, SESSION_HISTORY_IMAGE_MAX_PIXELS } from '@agentmux/core'
import { publicationImage, type PublicationImage } from './publication-resource.js'

const require = createRequire(import.meta.url)

/** A private, short-lived Host renderer. Diagram data cannot read files or use the network. */
export async function renderMermaidDiagram(source: string, options: {
  signal: AbortSignal; maxBytes: number; executablePath?: string
}): Promise<PublicationImage> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
  const checkObservation = () => {
    options.signal.throwIfAborted()
    if (signal.aborted) throw new AgentMuxError('The diagram render was not confirmed in this observation. Its source is kept.', 'MERMAID_RENDER_UNCONFIRMED')
  }
  checkObservation()
  const executablePath = options.executablePath ?? process.env.PUPPETEER_EXECUTABLE_PATH
  const browser = await browserEngine.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    headless: true, pipe: true, signal, timeout: 0, protocolTimeout: 0 }).catch(() => {
    checkObservation()
    throw new AgentMuxError('The Host diagram browser could not be started.', 'MERMAID_BROWSER_UNAVAILABLE')
  })
  let page: Awaited<ReturnType<typeof browser.newPage>> | undefined, blockedResource = false
  const resourceBlocked = async () => blockedResource || !!await page?.evaluate(() => document.documentElement.dataset.resourceBlocked === 'true').catch(() => false)
  try {
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
    await page.setRequestInterception(true)
    page.on('request', request => {
      blockedResource = true
      void request.abort().catch(() => { /* The private page may already be closing. */ })
    })
    await page.setContent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:"><style>body{margin:0;padding:16px;background:white}#diagram{display:inline-block}svg{display:block}</style><div id="diagram"></div>', { timeout: 0 })
    await page.evaluate(() => document.addEventListener('securitypolicyviolation', () => { document.documentElement.dataset.resourceBlocked = 'true' }))
    await page.addScriptTag({ content: await readFile(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8') })
    const size = await page.evaluate(async (text, bounds) => {
      const mermaid = (globalThis as unknown as { mermaid: typeof import('mermaid').default }).mermaid
      // Diagram directives cannot replace the renderer's policy, theme or resource budgets.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
        flowchart: { htmlLabels: false }, theme: 'default', suppressErrorRendering: true,
        // Render the whole original source instead of Mermaid's size-error diagram.
        maxTextSize: Math.max(mermaid.mermaidAPI.defaultConfig.maxTextSize!, text.length),
        secure: Object.keys(mermaid.mermaidAPI.defaultConfig) })
      const rendered = await mermaid.render('conversation-diagram', text)
      const container = document.getElementById('diagram')!
      container.innerHTML = rendered.svg
      const svg = container.querySelector('svg')!
      const box = svg.viewBox.baseVal
      const width = Math.ceil(box.width), height = Math.ceil(box.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
        width + 32 > bounds.dimension || height + 32 > bounds.dimension || (width + 32) * (height + 32) > bounds.pixels)
        return null
      svg.style.maxWidth = 'none'
      svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height))
      await document.fonts.ready
      return { width: width + 32, height: height + 32 }
    }, source, { dimension: SESSION_HISTORY_IMAGE_MAX_DIMENSION, pixels: SESSION_HISTORY_IMAGE_MAX_PIXELS })
    checkObservation()
    if (!size) throw new AgentMuxError('The diagram exceeds the renderer or image delivery budget. Its source is kept.', 'MERMAID_IMAGE_UNAVAILABLE')
    const bytes = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...size }, captureBeyondViewport: true })
    if (await resourceBlocked())
      throw new AgentMuxError('The diagram refers to a resource the isolated Host renderer cannot load.', 'MERMAID_RESOURCE_UNAVAILABLE')
    const image = readSessionHistoryImageBytes(bytes, options.maxBytes, 'image/png')
    if (image.status !== 'read') throw new AgentMuxError('The rendered diagram exceeds the image delivery budget.', 'MERMAID_IMAGE_UNAVAILABLE')
    return publicationImage(image)
  } catch (error) {
    checkObservation()
    if (error instanceof AgentMuxError) throw error
    if (await resourceBlocked()) throw new AgentMuxError('The diagram refers to a resource the isolated Host renderer cannot load.', 'MERMAID_RESOURCE_UNAVAILABLE')
    throw new AgentMuxError('The Host could not render this diagram. Its source is kept.', 'MERMAID_RENDER_FAILED')
  } finally { await browser.close() }
}
