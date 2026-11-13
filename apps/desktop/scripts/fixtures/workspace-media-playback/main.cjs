const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), http = require('node:http'), { spawn } = require('node:child_process')
const [html, profile, evidence, phase, nativeModule, workspacePath] = process.argv.slice(2)
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native host' }], executors: {},
  workspaces: [{ id: 'media-private', name: 'Media playback workspace', hostId: 'local', path: workspacePath, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let win, files, streams, spatialSubscription, liveEncoder
const report = { schema: 'agentmux.workspace-media-playback-process.v1', passed: false, phase, pid: process.pid, frames: [], checks: {}, consoleMessages: [], requests: [] }
const evaluate = code => win.webContents.executeJavaScript(code, true)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(code, timeout = 20000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await evaluate(code); if (value) return value; await sleep(100) }
  // Leave the screen and the File tree as evidence of why the fact never appeared.
  try { await fs.writeFile(path.join(evidence, 'wait-timeout.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
  report.layoutDiagnosis = await evaluate('mediaPlaybackProbe.layoutDiagnosis()').catch(error => String(error))
  report.mediaDiagnosis = await evaluate(`[...document.querySelectorAll('video,audio')].map(m=>({tag:m.tagName,src:m.getAttribute('src'),readyState:m.readyState,networkState:m.networkState,error:m.error&&m.error.code,duration:String(m.duration),w:m.videoWidth,decode:m.closest('.media-player')?.dataset.decodeState,parked:Boolean(m.closest('[data-active="false"],.workspace-workbench-slot--parked,[data-workbench-layout-state="parked"]')),connected:m.isConnected}))`).catch(error => String(error))
  report.openDiagnosis = await evaluate('JSON.parse(JSON.stringify(window.mediaPlaybackOpen ?? null))').catch(error => String(error))
  report.waitTimeout = await evaluate(`({ tree: [...document.querySelectorAll('[data-tree-path]')].map(e=>e.getAttribute('data-tree-path')).slice(0,20), body: document.body.innerText.slice(0,400) })`).catch(error => String(error))
  assert.fail('Missing actual Renderer fact: ' + code)
}
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await sleep(120) }
async function frame(name) { await paint(); const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); report.frames.push({ name, file }) }
const player = file => evaluate(`mediaPlaybackProbe.player(${JSON.stringify(file)})`)
/** Relative luminance of a computed CSS colour in the forms the engine returns: rgb(), color(srgb …) or oklab(). */
function relativeLuminance(css) {
  const lin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  const fromSrgb = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(css)
  if (rgb) return fromSrgb(...rgb.slice(1, 4).map(value => Number(value) / 255))
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(css)
  if (srgb) return fromSrgb(...srgb.slice(1, 4).map(Number))
  // OKLab lightness is the cube root of luminance for a neutral colour; close enough to rank a fill against the scrim.
  const lab = /^oklab\(([\d.]+)/.exec(css)
  if (lab) return Number(lab[1]) ** 3
  throw new Error('Unreadable computed colour: ' + css)
}

/** Count bytes the lease server actually sent, per path, by wrapping its listener once it starts. */
function meter() {
  const original = http.Server.prototype.emit
  http.Server.prototype.emit = function (event, request, response) {
    if (event === 'request' && request && response && typeof request.url === 'string' && /^\/[A-Za-z0-9_-]{43}\//.test(request.url)) {
      const entry = { path: decodeURIComponent(request.url.slice(45).split('?')[0]), range: request.headers.range ?? null, status: 0, bytes: 0, at: Date.now() }
      report.requests.push(entry)
      const write = response.write.bind(response), end = response.end.bind(response), head = response.writeHead.bind(response)
      response.writeHead = (status, ...rest) => { entry.status = status; entry.repliedAt = Date.now(); return head(status, ...rest) }
      response.write = (chunk, ...rest) => { if (chunk) entry.bytes += chunk.length; return write(chunk, ...rest) }
      response.once('close', () => { entry.closed = true })
      response.end = (chunk, ...rest) => { if (chunk && typeof chunk !== 'function') entry.bytes += chunk.length; entry.status ||= response.statusCode; return end(chunk, ...rest) }
    }
    return original.apply(this, arguments)
  }
}
const sentFor = file => report.requests.filter(entry => entry.path === file).reduce((sum, entry) => sum + entry.bytes, 0)
const requestsFor = file => report.requests.filter(entry => entry.path === file)

async function capture() {
  await wait(`typeof window.mediaPlaybackProbe === 'object'`)
  await wait(`Boolean(document.querySelector('.workbench-region'))`)
  // 1. The 55 MB file from the report plays. Before play, only the index is read.
  await evaluate(`mediaPlaybackProbe.open("promo.mp4")`)
  await wait(`mediaPlaybackProbe.player("promo.mp4")?.decode === 'ready'`)
  const ready = await player('promo.mp4')
  assert.equal(ready.kind, 'video'); assert.ok(ready.width > 0, 'A real decoded picture'); assert.match(ready.src, /^http:\/\/127\.0\.0\.1:\d+\//)
  // Chromium sizes its own read-ahead (6–32 MiB observed across runs for this file). What the lease owns:
  // an idle, unplayed player stops reading, so the open never drains the whole file in the background.
  await sleep(1500)
  const settled = sentFor('promo.mp4')
  await sleep(4000)
  const beforePlay = sentFor('promo.mp4'), size = (await fs.stat(path.join(workspacePath, 'promo.mp4'))).size
  report.checks.bytesBeforePlay = beforePlay; report.checks.idleGrowth = beforePlay - settled; report.checks.fileBytes = size
  assert.ok(beforePlay > 0 && beforePlay < size, `Opening does not read the whole file: ${beforePlay} of ${size}`)
  assert.ok(beforePlay - settled <= 1024 * 1024, `An idle, unplayed player stops reading: +${beforePlay - settled} bytes in 4 s`)
  await frame('video-start-dark')
  await evaluate(`mediaPlaybackProbe.play("promo.mp4")`)
  await wait(`mediaPlaybackProbe.player("promo.mp4")?.currentTime > 1`)
  await evaluate(`mediaPlaybackProbe.pause("promo.mp4")`)
  await evaluate(`mediaPlaybackProbe.seekFraction("promo.mp4", 0.8)`)
  await wait(`(()=>{const p=mediaPlaybackProbe.player("promo.mp4");return p&&p.currentTime>p.duration*0.79&&p.readyState>=2})()`)
  const ranged = requestsFor('promo.mp4').filter(entry => entry.status === 206 && entry.range && Number(/bytes=(\d+)-/.exec(entry.range)?.[1]) > 0)
  assert.ok(ranged.length > 0, 'Seeking far reads by Range, not from the start')
  report.checks.seekRanges = ranged.map(entry => entry.range)
  await evaluate(`mediaPlaybackProbe.showControls("promo.mp4")`); await evaluate(`mediaPlaybackProbe.hover("promo.mp4", 0.35)`)
  await frame('video-controls-dark')
  const darkAccent = await evaluate(`mediaPlaybackProbe.timelineFill("promo.mp4")`)
  await evaluate(`mediaPlaybackProbe.theme("light")`); await evaluate(`mediaPlaybackProbe.showControls("promo.mp4")`); await frame('video-controls-light')
  // Over the dark scrim the played part of the timeline must stay brighter than the buffered white wash in both themes.
  const lightAccent = await evaluate(`mediaPlaybackProbe.timelineFill("promo.mp4")`)
  report.checks.timelineAccent = { dark: darkAccent, light: lightAccent }
  for (const [theme, color] of Object.entries(report.checks.timelineAccent)) assert.ok(relativeLuminance(color) > 0.7, `The ${theme} timeline fill reads on the scrim: ${color}`)
  await evaluate(`mediaPlaybackProbe.theme("dark")`)
  report.checks.totalBytes = sentFor('promo.mp4')
  assert.ok(report.checks.totalBytes < size, `Watching and seeking did not read the whole file: ${report.checks.totalBytes} of ${size}`)

  // 2. A narrow Region keeps play, mute, time and full screen reachable.
  await evaluate(`mediaPlaybackProbe.split("promo.mp4", "notes.md", 0.34)`); await sleep(400)
  await evaluate(`mediaPlaybackProbe.showControls("promo.mp4")`)
  const narrow = await player('promo.mp4'); assert.ok(narrow.region.width < 520, 'Region is narrow')
  const reachable = await evaluate(`(()=>{const r=[...document.querySelectorAll('.media-player__bar button')].filter(b=>getComputedStyle(b).display!=='none');return r.map(b=>{const x=b.getBoundingClientRect();const hit=document.elementFromPoint(x.x+x.width/2,x.y+x.height/2);return{label:b.getAttribute('aria-label'),ok:x.width>0&&(hit===b||b.contains(hit))}})})()`)
  report.checks.narrowControls = reachable
  const roles = [['play', /^(Play|Pause|Play again)$/], ['mute', /^(Mute|Unmute)$/], ['time', /time$/], ['full screen', /^(Full screen|Exit full screen)$/]]
  if (!roles.every(([, label]) => reachable.some(item => label.test(item.label) && item.ok))) await frame('video-narrow-unreachable')
  for (const [role, label] of roles) assert.ok(reachable.some(item => label.test(item.label) && item.ok), 'Narrow control reachable: ' + role + ' ' + JSON.stringify(reachable))
  report.checks.narrowControls = reachable
  await frame('video-narrow-dark')

  // 3. Audio card.
  await evaluate(`mediaPlaybackProbe.open("tone.m4a")`); await wait(`mediaPlaybackProbe.player("tone.m4a")?.decode === 'ready'`)
  assert.equal((await player('tone.m4a')).kind, 'audio'); await frame('audio-card-dark')
  await evaluate(`mediaPlaybackProbe.theme("light")`); await frame('audio-card-light'); await evaluate(`mediaPlaybackProbe.theme("dark")`)
  await evaluate(`mediaPlaybackProbe.split("tone.m4a", "notes.md", 0.3)`); await sleep(400); await frame('audio-card-narrow-dark')

  // 3b. With reduced motion, a key's feedback is still shown and held before it leaves (real engine cascade).
  await evaluate(`mediaPlaybackProbe.open("promo.mp4")`); await wait(`mediaPlaybackProbe.player("promo.mp4")?.decode === 'ready'`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate(`mediaPlaybackProbe.focusPlayer("promo.mp4")`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'L' }); win.webContents.sendInputEvent({ type: 'char', keyCode: 'l' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'L' })
  await sleep(300)
  const held = await evaluate(`mediaPlaybackProbe.indicator("promo.mp4")`)
  await sleep(1200)
  const after = await evaluate(`mediaPlaybackProbe.indicator("promo.mp4")`)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); win.webContents.debugger.detach()
  report.checks.reducedMotionIndicator = { held, after }
  assert.equal(held?.text, '+10s', 'Under reduced motion the key feedback is on screen 300 ms later')
  assert.equal(Number(held.opacity), 1, 'Under reduced motion the key feedback is fully visible, not faded')
  assert.equal(after, null, 'Under reduced motion the key feedback still leaves once its hold ends')

  // 4. HLS on demand, and a live list that ffmpeg is still writing.
  await evaluate(`mediaPlaybackProbe.open("hls/index.m3u8")`); await wait(`mediaPlaybackProbe.player("hls/index.m3u8")?.decode === 'ready'`)
  const vod = await player('hls/index.m3u8'); assert.equal(vod.stream, 'on-demand'); report.checks.hlsVod = vod
  await frame('hls-vod-dark')
  // A live list that an encoder is writing right now: started here so it is still live while playing.
  liveEncoder = spawn('ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '90',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+temp_file', path.join(workspacePath, 'live/live.m3u8')], { stdio: 'ignore' })
  // Open it once the list carries a full window, as a stream that has been running does; a list of three
  // two-second segments leaves Chromium no margin at the live edge on a loaded machine.
  for (let waited = 0; waited < 30000; waited += 250) { try { if ((await fs.readFile(path.join(workspacePath, 'live/live.m3u8'), 'utf8')).split('#EXTINF').length > 6) break } catch {} await sleep(250) }
  report.checks.openPlayersBeforeLive = await evaluate(`[...document.querySelectorAll('.media-player video, .media-player audio')].map(m=>({src:(m.getAttribute('src')||'').split('/').pop(),net:m.networkState,paused:m.paused,parked:Boolean(m.closest('[data-active="false"],.workspace-workbench-slot--parked'))}))`)
  report.checks.openSocketsBeforeLive = report.requests.filter(entry => !entry.closed).length
  await evaluate(`mediaPlaybackProbe.open("live/live.m3u8")`)
  await evaluate(`(()=>{window.liveEvents=[];const t0=performance.now();const tap=()=>{const m=document.querySelector('[data-workbench-region-id] .media-player video[src*="live.m3u8"]');if(!m){setTimeout(tap,20);return}for(const e of ['loadstart','loadedmetadata','loadeddata','canplay','play','playing','waiting','stalled','suspend','abort','emptied','error','durationchange','seeking','seeked','pause'])m.addEventListener(e,()=>window.liveEvents.push([e,Math.round(performance.now()-t0),m.readyState,m.error&&m.error.code,m.currentTime.toFixed(2),m.error&&m.error.message]))};tap()})()`)
  try { await wait(`mediaPlaybackProbe.player("live/live.m3u8")?.decode === 'ready'`, 30000) } finally { report.checks.liveEvents = await evaluate('window.liveEvents') }
  await evaluate(`mediaPlaybackProbe.play("live/live.m3u8")`)
  try { await wait(`mediaPlaybackProbe.player("live/live.m3u8")?.currentTime > 2`, 30000) } finally { report.checks.liveEvents = await evaluate('window.liveEvents') }
  const live = await player('live/live.m3u8')
  assert.equal(live.duration, 'Infinity'); assert.match(live.stream, /^live/); assert.ok(!/Infinity|NaN/.test(live.text), 'No fake duration is shown')
  report.checks.live = live
  // While it plays, the list is reloaded at a paced rate instead of spinning on an unchanged list.
  const windowStart = Date.now(); await sleep(15000)
  const listRequests = requestsFor('live/live.m3u8').filter(entry => entry.at >= windowStart)
  report.checks.livePlaylistRequests = listRequests.length
  assert.ok(listRequests.length <= 20, `Live list reloads stay paced: ${listRequests.length} in 15 s`)
  await evaluate(`mediaPlaybackProbe.showControls("live/live.m3u8")`); await frame('live-dark')
  await evaluate(`mediaPlaybackProbe.theme("light")`); await evaluate(`mediaPlaybackProbe.showControls("live/live.m3u8")`); await frame('live-light'); await evaluate(`mediaPlaybackProbe.theme("dark")`)

  // 5. A deleted file is named as deleted, not as an unsupported codec.
  await evaluate(`mediaPlaybackProbe.open("doomed.mp4")`); await wait(`mediaPlaybackProbe.player("doomed.mp4")?.decode === 'ready'`)
  await fs.rm(path.join(workspacePath, 'doomed.mp4'))
  // The tail was never requested, so this seek must ask the lease owner for bytes that no longer exist.
  const unread = requestsFor('doomed.mp4').every(entry => Number(/bytes=(\d+)-/.exec(entry.range ?? '')?.[1] ?? 0) < 40 * 1024 * 1024)
  report.checks.deletedTailUnread = unread
  await evaluate(`mediaPlaybackProbe.seekFraction("doomed.mp4", 0.95)`)
  await wait(`Boolean(mediaPlaybackProbe.player("doomed.mp4")?.alert)`, 20000)
  const gone = await player('doomed.mp4'); report.checks.deleted = gone.alert
  assert.match(gone.alert, /File was deleted/); assert.doesNotMatch(gone.alert, /Format not supported/)
  await frame('deleted-dark')

  // Leave the player on screen for the restart phase.
  await evaluate(`mediaPlaybackProbe.open("promo.mp4")`); await wait(`mediaPlaybackProbe.player("promo.mp4")?.decode === 'ready'`)
  await evaluate('mediaPlaybackProbe.flush()')
  await fs.writeFile(path.join(evidence, 'expected-durable.json'), JSON.stringify(await evaluate('mediaPlaybackProbe.facts()')))
}

async function restart() {
  await wait(`typeof window.mediaPlaybackProbe === 'object'`)
  const expected = JSON.parse(await fs.readFile(path.join(evidence, 'expected-durable.json'), 'utf8')), actual = await evaluate('mediaPlaybackProbe.beforeFixture')
  assert.deepEqual(actual.tabs, expected.tabs); assert.deepEqual(actual.layouts, expected.layouts); assert.equal(actual.activeWorkspaceId, expected.activeWorkspaceId)
  await wait(`mediaPlaybackProbe.player("promo.mp4")?.decode === 'ready'`)
  const again = await player('promo.mp4'); assert.ok(again.width > 0)
  // The restored player shows a picture, not an empty stage. Sample the painted stage away from the centre play
  // disc and the bottom controls (its upper-left quarter), so only the picture itself can make it bright.
  const pictureBrightness = async () => {
    await paint()
    const area = await evaluate(`(()=>{const r=document.querySelector('[data-workbench-region-id] .media-player__stage').getBoundingClientRect();return{x:Math.round(r.x+r.width*0.08),y:Math.round(r.y+r.height*0.1),width:Math.max(8,Math.round(r.width*0.22)),height:Math.max(8,Math.round(r.height*0.2))}})()`)
    const pixels = (await win.webContents.capturePage(area)).toBitmap()
    let sum = 0; for (let index = 0; index < pixels.length; index += 4) sum += pixels[index] + pixels[index + 1] + pixels[index + 2]
    return sum / (pixels.length / 4) / 3
  }
  // A restored workface reaches the compositor a moment after the engine reports a decoded frame; wait for the
  // picture itself, bounded, rather than accepting the decoded fact or a first sample taken before it is painted.
  let brightness = 0
  for (const until = Date.now() + 10000; Date.now() < until && (brightness = await pictureBrightness()) <= 24;) await sleep(250)
  report.checks.restart = { src: again.src, readyState: again.readyState, stageBrightness: Math.round(brightness) }
  await frame('restart-dark')
  assert.ok(brightness > 24, `The restored player paints its picture, not an empty stage: mean ${brightness.toFixed(1)}`)
  report.durable = { passed: true }
}

app.whenReady().then(async () => { try {
  meter()
  const { WorkspaceFiles, WorkspaceMediaStreams, AgentMuxSpatialStateStore, WORKSPACE_FILE_INVALIDATED_CHANNEL } = await import(nativeModule)
  // The real Core spatial owner persists Tabs, Regions and layout across the two processes.
  const spatial = new AgentMuxSpatialStateStore(path.join(profile, 'spatial-state.json'))
  ipcMain.handle('spatial:read', () => spatial.read()); ipcMain.handle('spatial:commit', (_event, input) => spatial.commit(input))
  ipcMain.handle('spatial:retainLabels', (_event, values) => spatial.retainDisplayLabels(values))
  spatialSubscription = spatial.subscribe(state => win?.webContents.send('spatial:changed', state))
  files = new WorkspaceFiles(() => ({ kind: 'local' }))
  const workspace = id => { const found = config.workspaces.find(item => item.id === id); if (!found) throw Object.assign(Error('Unknown private workspace: ' + id), { code: 'ENOENT' }); return found }
  streams = new WorkspaceMediaStreams(files, id => config.workspaces.find(item => item.id === id))
  const observed = new Map()
  ipcMain.on('fixture:boot', event => { event.returnValue = { config, phase } })
  ipcMain.handle('git:status', () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath }))
  for (const [channel, method] of [['files:readDirectory', 'readDirectory'], ['files:read', 'read'], ['files:readPreview', 'readPreview'], ['files:write', 'write']])
    ipcMain.handle(channel, async (_event, id, input, options) => await files[method](workspace(id), input, options))
  ipcMain.handle('files:observe', async (event, id, file) => { const key = id + '\0' + file; if (!observed.has(key)) observed.set(key, await files.observe(workspace(id), file, () => event.sender.send(WORKSPACE_FILE_INVALIDATED_CHANNEL, { workspaceId: id, path: file }))) })
  ipcMain.handle('files:unobserve', async (_event, id, file) => { const key = id + '\0' + file; await observed.get(key)?.(); observed.delete(key) })
  ipcMain.handle('files:openMediaStream', async (_event, id, file) => await streams.open(workspace(id), file))
  ipcMain.handle('files:releaseMediaStream', async (_event, id) => { streams.release(id) })
  ipcMain.handle('files:mediaStreamStatus', async (_event, id) => streams.status(id))
  ipcMain.handle('files:reveal', () => { throw Error('Capture does not open system UI') }); ipcMain.handle('files:openSystem', () => { throw Error('Capture does not open system applications') })
  win = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.cjs') } })
  win.webContents.on('console-message', (_event, _level, message) => { report.consoleMessages.push(message) })
  await win.loadFile(html, { query: { phase } })
  if (phase === 'restart') await restart(); else await capture()
  assert.equal(report.consoleMessages.some(message => message.includes('Content Security Policy')), false, 'No media request is blocked by the production CSP')
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { liveEncoder?.kill('SIGKILL'); spatialSubscription?.(); await streams?.dispose(); await files?.dispose(); await fs.writeFile(path.join(evidence, phase + '-render.json'), JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1) } })
