import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Same private inspector / seeded-then-ordinary-launch seam as the maintained Browser and
// Workbench restart proofs. This drives the real product bundles, not a replacement Main or UI.
export async function connectCdp(url, connections) {
  const socket = new WebSocket(url), pending = new Map(), pauses = []
  const cdp = { pauses, close: () => socket.close() }
  connections.add(cdp)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Private CDP handshake timed out')), 12_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
  })
  let serial = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Debugger.paused') pauses.push(message.params)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Private CDP closed')) }
    pending.clear()
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 12_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  Object.assign(cdp, { call, async evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  } })
  return cdp
}

export function desktopFixture({ desktopRoot, root, privateHome, environment, children, connections, waitFor, packagedApplication, beforeRuntimePrepare }) {
  const require = createRequire(join(desktopRoot, 'package.json'))
  return async function launch(label, seed) {
    for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY']) {
      assert.equal(process.env[name], undefined, `Private launch inherited ${name}`)
    }
    const readyFile = join(root, `ready-${label}.json`), report = join(root, 'seed-report.json')
    const executable = packagedApplication ? join(packagedApplication, 'Contents/MacOS/AgentMux') : require('electron')
    const args = ['--inspect-brk=0', ...(packagedApplication ? [] : [join(desktopRoot, 'out/main/index.js')]), '--remote-debugging-port=0', `--user-data-dir=${environment.AGENTMUX_DESKTOP_USER_DATA}`]
    const child = spawn(executable, args, {
      cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...environment, AGENTMUX_DESKTOP_READY_FILE: readyFile,
        ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed), AGENTMUX_DESKTOP_RECOVERY_REPORT: report,
          AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1' } : {}) }
    })
    assert.ok(child.pid > 1)
    children.add(child)
    let diagnostics = '', mainUrl, rendererUrl, spawnError
    child.once('error', error => { spawnError = error })
    child.stderr.on('data', bytes => {
      diagnostics = (diagnostics + bytes).slice(-16_384)
      mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
      rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    })
    const alive = () => {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Private ${label} exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`)
    }
    const main = await connectCdp(await waitFor(`${label} Main inspector`, () => { alive(); return mainUrl }), connections)
    await main.call('Runtime.enable'); await main.call('Debugger.enable')
    const mainPath = join(desktopRoot, 'out/main/index.js')
    const anchors = (await readFile(mainPath, 'utf8')).split('\n').flatMap((line, index) => (
      line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [index] : []
    ))
    assert.equal(anchors.length, 1, 'Private home isolation needs the exact compiled home boundary')
    const breakpoint = await main.call('Debugger.setBreakpointByUrl', { urlRegex: mainPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', lineNumber: anchors[0] })
    await main.call('Runtime.runIfWaitingForDebugger')
    let paused = await waitFor(`${label} bootstrap pause`, () => main.pauses.shift())
    if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) {
      await main.call('Debugger.resume')
      paused = await waitFor(`${label} home boundary`, () => main.pauses.shift())
    }
    assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId))
    const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
      expression: `(() => { app.setPath('home', ${JSON.stringify(privateHome)}); return app.getPath('home') })()`, returnByValue: true })
    assert.equal(isolated.exceptionDetails, undefined); assert.equal(isolated.result.value, privateHome)
    await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId })
    if (beforeRuntimePrepare) {
      // An explicit private fixture seam; ordinary launches still execute the original preparation.
      const preparationAnchors = (await readFile(mainPath, 'utf8')).split('\n').flatMap((line, index) =>
        line.includes('args.runtime.commit(await args.runtime.prepare(config))') ? [index] : [])
      assert.equal(preparationAnchors.length, 1)
      const preparation = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: preparationAnchors[0] })
      await main.call('Debugger.resume')
      const frame = await waitFor(`${label} private preparation boundary`, () => main.pauses.shift())
      assert.ok(frame.hitBreakpoints?.includes(preparation.breakpointId))
      await beforeRuntimePrepare(main, frame.callFrames[0].callFrameId)
      await main.call('Debugger.removeBreakpoint', { breakpointId: preparation.breakpointId })
    }
    await main.call('Debugger.resume')
    const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
    const target = await waitFor(`${label} Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`, { signal: AbortSignal.timeout(5_000) })).json())
      .find(item => item.type === 'page' && item.url.startsWith('file:')))
    const cdp = await connectCdp(target.webSocketDebuggerUrl, connections)
    await cdp.call('Runtime.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    const ready = await waitFor(`${label} ready`, async () => {
      try { return JSON.parse(await readFile(readyFile, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; alive(); return null }
    })
    if (seed) {
      // Node waits for an attached inspector on exit. Detach our own observers once the
      // ready file proves seed completion, then demand the actual clean process exit.
      main.close(); cdp.close()
      try { await waitFor('seed exit', () => child.exitCode !== null || child.signalCode !== null) }
      catch (error) { throw new Error(`${error.message}; private diagnostics=${diagnostics}`) }
      assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null)
      children.delete(child)
      return { report: JSON.parse(await readFile(report, 'utf8')) }
    }
    await waitFor(`${label} actual App`, () => cdp.evaluate('Boolean(window.agentmux && document.querySelector(".app-shell"))'))
    assert.equal(await cdp.evaluate('(async()=> (await window.agentmux.sessions.snapshot()).localHome)()'), privateHome)
    return { child, main, cdp, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  }
}

export async function key(cdp, key, code) {
  const windowsVirtualKeyCode = key === 'Enter' ? 13 : undefined
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
}

/** Focus/select only; the actual action is a trusted native input event in this private Renderer. */
export async function activate(cdp, expression) {
  const focused = await cdp.evaluate(`(() => {
    const matches = (${expression}).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    if (matches.length !== 1) throw new Error('Expected one named control, got '+matches.length)
    const element = matches[0]; if (element.disabled) throw new Error('Named control disabled')
    element.scrollIntoView({block:'nearest'}); element.focus(); return document.activeElement === element
  })()`)
  assert.equal(focused, true, 'The exact visible control must accept focus')
  await key(cdp, 'Enter', 'Enter')
}

export async function click(cdp, selector) {
  const point = await cdp.evaluate(`(() => {
    const matches = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e => e.getClientRects().length)
    if (matches.length !== 1) throw new Error('Expected one exact control, got '+matches.length)
    const element = matches[0]; if (element.disabled) throw new Error('Named control disabled')
    element.scrollIntoView({block:'nearest'}); const r=element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}
  })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
