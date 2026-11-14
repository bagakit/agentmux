const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), fsSync = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), http = require('node:http'), { spawn, execFileSync } = require('node:child_process')
const [html, profile, evidence, phase, nativeModule, workspacePath] = process.argv.slice(2)
const privatePaths = { home: process.env.HOME, appData: path.join(profile, 'app-data'),
  userData: path.join(profile, 'user-data'), sessionData: path.join(profile, 'session-data') }
for (const [name, directory] of Object.entries(privatePaths)) app.setPath(name, directory)
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
async function frame(name, settled = true) { if (settled) await paint(); const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); report.frames.push({ name, file }) }
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
const KiB = 1024, MiB = 1024 * KiB, FRAME = 1 / 30 + 0.001
const startOf = entry => Number(/bytes=(\d+)-/.exec(entry.range ?? '')?.[1] ?? 0)
const openedFor = (file, since, until = Infinity) => requestsFor(file).filter(entry => entry.at >= since && entry.at < until)
const bytesOf = entries => entries.reduce((sum, entry) => sum + entry.bytes, 0)

// Real pointer input in window px. A held move carries the pressed button, as the moves of a drag do.
const pointer = {
  move: (x, y, held = false) => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), ...(held ? { modifiers: ['leftButtonDown'] } : {}) }),
  down: (x, y) => win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }),
  up: (x, y) => win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
}
// The native range maps a press over the thumb's travel and lands on one of its 1000 steps: the time a press at x lands on.
const valueAt = (g, x) => Math.min(1, Math.max(0, (x - g.left - g.thumb / 2) / (g.width - g.thumb))) * 1000
const timeAt = (g, x) => g.start + Math.round(valueAt(g, Math.round(x))) / 1000 * (g.end - g.start)
// The window pixel nearest a fraction of the timeline whose value sits at least 0.2 step away from a half-step boundary.
function pixelAt(g, fraction, around = g.left + g.thumb / 2 + fraction * (g.width - g.thumb)) {
  for (let offset = 0; offset < 8; offset++) for (const x of [Math.round(around) + offset, Math.round(around) - offset]) {
    const value = valueAt(g, x); if (Math.abs(value - Math.round(value)) <= 0.3) return x
  }
  throw new Error('No pixel away from a half-step boundary near ' + around)
}
// Arrival: the element finished seeking and holds the frame at its official position, read only then.
const arrived = (state, time, tolerance) => Boolean(state) && !state.seeking && state.readyState >= 2 && Math.abs(state.currentTime - time) <= tolerance
async function until(read, test, timeout) {
  const started = Date.now()
  for (;;) { const value = await read(); if (test(value)) return { value, ms: Date.now() - started }; if (Date.now() - started > timeout) return { value, ms: null }; await sleep(25) }
}
const previewOf = file => evaluate(`mediaPlaybackProbe.preview(${JSON.stringify(file)})`)
const mainOf = file => evaluate(`mediaPlaybackProbe.main(${JSON.stringify(file)})`)
const timelineOf = file => evaluate(`mediaPlaybackProbe.timeline(${JSON.stringify(file)})`)
const watchState = () => evaluate('mediaPlaybackProbe.watchState()')

/** The fixture's own keyframe and packet tables, and the largest byte span between consecutive keyframes. */
function keyframes(file) {
  const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,pos,flags', '-of', 'json', file], { maxBuffer: 64 * MiB })).packets
    .map(packet => ({ time: Number(packet.pts_time), pos: Number(packet.pos), key: packet.flags.startsWith('K') }))
  const keys = packets.filter(packet => packet.key).sort((a, b) => a.pos - b.pos)
  return { packets, keys, gop: Math.max(...keys.slice(1).map((key, index) => key.pos - keys[index].pos)) }
}
/** Where decoding a pointed time reads: from its keyframe to its packet, plus at most one more group of pictures. */
function windowAt(table, time) {
  const kf = table.keys.filter(key => key.time <= time + 1e-6).at(-1).pos
  const target = table.packets.filter(packet => packet.time <= time + 1e-6).reduce((best, packet) => packet.time > best.time ? packet : best).pos
  return { time, kf, target, from: kf - MiB, to: target + table.gop }
}
/** The end of the file's index: where its media data begins. */
function mediaDataStart(file) {
  const handle = fsSync.openSync(file, 'r'), head = Buffer.alloc(16)
  try {
    for (let at = 0; ;) {
      fsSync.readSync(handle, head, 0, 16, at)
      const short = head.readUInt32BE(0), type = head.toString('latin1', 4, 8), size = short === 1 ? Number(head.readBigUInt64BE(8)) : short
      if (type === 'mdat') return at + (short === 1 ? 16 : 8)
      assert.ok(size >= 8, 'A readable top-level box at ' + at); at += size
    }
  } finally { fsSync.closeSync(handle) }
}
/** Ends a pointing by moving to the picture above the timeline, then waits for the preview decoder to let go. */
async function releasePreview(file, g) {
  pointer.move(g.left + g.width / 2, g.stage.top + 40)
  const gone = await until(() => previewOf(file), state => !state.decoder, 6000)
  assert.ok(gone.ms !== null, 'The preview decoder lets go after the pointer leaves')
  return gone.ms
}
/** The frame callback's presented media time for one measurement: evidence beside the comparison, never the comparison. */
function presented(measurement, entries, time) {
  const hit = entries.filter(entry => entry && Math.abs(entry.mediaTime - time) <= FRAME).at(-1)
  const record = { measurement, obtained: Boolean(hit), mediaTime: hit?.mediaTime ?? null }
  ;(report.checks.frameCallbacks ??= []).push(record)
  return record
}

/** The pointed-frame preview on the real File chain: what it reads and where, release, continuous pointing, dragging and accuracy. */
async function previewPhase(size) {
  const file = 'promo.mp4', q = JSON.stringify(file), full = path.join(workspacePath, file), checks = report.checks
  const table = keyframes(full), indexEnd = mediaDataStart(full)
  checks.previewVisibility = await evaluate('document.visibilityState')
  assert.equal(checks.previewVisibility, 'visible', 'The never-shown capture window reports a visible document, so pointing is not ended as hidden')
  await evaluate(`mediaPlaybackProbe.pause(${q})`); await evaluate(`mediaPlaybackProbe.showControls(${q})`); await evaluate(`mediaPlaybackProbe.watch(${q})`)
  const g = await timelineOf(file), above = { x: g.left + g.width / 2, y: g.stage.top + 40 }
  pointer.move(above.x, above.y)
  // Main playback is paused: once its reads stop growing, a request opened in this phase is the preview's.
  for (let last = -1, quiet = 0, tries = 0; quiet < 3; tries++) {
    assert.ok(tries < 60, 'Main playback reads settle while paused')
    const now = sentFor(file); quiet = now === last ? quiet + 1 : 0; last = now; await sleep(500)
  }
  const baseline = Date.now(), mainBefore = await mainOf(file)
  // A preview read carried on a connection opened before the baseline would escape attribution.
  const sentBeforeBaseline = () => bytesOf(requestsFor(file).filter(entry => entry.at < baseline)), sentAtBaseline = sentBeforeBaseline()

  // A crossing on the way elsewhere opens nothing. Its time on the bar comes from the page's own pointer events.
  const crossX = pixelAt(g, 0.3)
  for (let attempt = 1; ; attempt++) {
    await evaluate('mediaPlaybackProbe.resetPeaks()')
    const since = Date.now()
    pointer.move(crossX, g.y - 30); await sleep(100); pointer.move(crossX, g.y); await sleep(16); pointer.move(crossX, g.y + 30); await sleep(800)
    const crossing = (await watchState()).crossings.at(-1), decoder = (await previewOf(file)).decoder !== null
    checks.previewCrossing = { attempt, onBarMs: crossing?.out == null ? null : Math.round(crossing.out - crossing.over), requests: openedFor(file, since).length, decoder }
    if (checks.previewCrossing.onBarMs !== null && checks.previewCrossing.onBarMs <= 50) break
    assert.ok(attempt < 4, 'A crossing of at most 50 ms on the bar could be made: ' + JSON.stringify(checks.previewCrossing))
    if (decoder) await releasePreview(file, g)
  }
  assert.equal(checks.previewCrossing.requests, 0, 'A crossing opens no request'); assert.equal(checks.previewCrossing.decoder, false, 'A crossing makes no decoder')

  // Three positions in one pointing, each reached by one jump. Bytes read before the positions may come from the platform's
  // shared cache without a request, so each position's whole window lies in bytes nobody has read yet. The windows judge the
  // requests opened from the baseline until the release after the return; the steps after it are judged by their own rules.
  const chosenAt = Date.now(), openedBeforePositions = () => requestsFor(file).filter(entry => entry.at < chosenAt)
  const readBefore = openedBeforePositions().map(entry => [startOf(entry), startOf(entry) + entry.bytes]), sentAtPositions = bytesOf(openedBeforePositions())
  const unread = (from, to, read = readBefore) => read.every(([start, end]) => end <= from || start >= to)
  const positions = []
  for (const key of [...table.keys].sort((a, b) => a.time - b.time)) {
    const x = pixelAt(g, (key.time + 0.5) / (g.end - g.start)), position = { fraction: Math.round(valueAt(g, x)) / 1000, x, ...windowAt(table, timeAt(g, x)) }
    if (position.kf !== key.pos || !unread(position.from, position.to) || (positions.length && position.from <= positions.at(-1).to)) continue
    positions.push(position)
    if (positions.length === 3) break
  }
  assert.equal(positions.length, 3, 'Three positions whose windows nobody read before them; with fewer, main playback read too much of this fixture for the run, which is unfit rather than the condition relaxed: ' + JSON.stringify({ readBefore, positions }))
  for (let index = 1; index < positions.length; index++) assert.ok(positions[index].from > positions[index - 1].to, 'Position windows do not overlap: ' + JSON.stringify(positions))
  // Windows judge where requests start: what a request sends runs past them by what the socket buffered and no decoder read.
  // A paused decoder restarts its reads up to about 3 s past its target, so the bound holds only for a fixture whose windows
  // admit at least 4 s there.
  const keysByTime = [...table.keys].sort((a, b) => a.time - b.time), widest = table.keys.findIndex((key, index) => index > 0 && key.pos - table.keys[index - 1].pos === table.gop)
  const admits = positions.map(position => table.packets.reduce((last, packet) => packet.pos <= position.to ? Math.max(last, packet.time) : last, 0) - position.time)
  checks.previewWindows = { gop: table.gop, gopSeconds: table.keys[widest].time - table.keys[widest - 1].time, admitsSeconds: Math.min(...admits),
    indexEnd, keyframes: table.keys.length, readBefore, positions: positions.map(({ fraction, time, kf, target, from, to }) => ({ fraction, time, kf, target, from, to })) }
  assert.ok(checks.previewWindows.admitsSeconds >= 4, 'Each window admits at least 4 s of media past its target; a fixture with shorter groups of pictures does not fit this bound: ' + JSON.stringify(checks.previewWindows))
  for (const [index, position] of positions.entries()) {
    position.since = Date.now()
    pointer.move(position.x, g.y)
    const shown = await until(() => previewOf(file), state => state.frame && arrived(state.decoder, position.time, 0.0005), index === 0 ? 3000 : 1000)
    assert.ok(shown.ms !== null, `Pointed frame ${index + 1} shows within ${index === 0 ? 3 : 1} s: ${JSON.stringify(shown.value)}`)
    position.frameMs = shown.ms; position.decoder = shown.value.decoder.index
    if (index === 1) {
      checks.previewCentre = { pointer: position.x, centre: shown.value.box.centre }
      assert.ok(Math.abs(shown.value.box.centre - position.x) <= 2, 'Away from the edges the preview is centred on the pointer: ' + JSON.stringify(checks.previewCentre))
      await frame('preview-mid-dark')
    }
    // The platform finishes the read-ahead the window admits, then reads stop: no growth for 500 ms, the last growth within 1 s.
    const shownAt = Date.now(), shownBytes = bytesOf(openedFor(file, baseline))
    let read = shownBytes, grewAt = shownAt
    while (Date.now() - grewAt < 500 && Date.now() - shownAt < 5000) { await sleep(50); const now = bytesOf(openedFor(file, baseline)); if (now !== read) { read = now; grewAt = Date.now() } }
    position.stopMs = grewAt - shownAt; position.afterFrame = read - shownBytes
    assert.ok(position.stopMs <= 1000, `Preview reads stop within 1 s of frame ${index + 1} showing: last growth ${position.stopMs} ms after, +${position.afterFrame} bytes`)
    await sleep(4000)
    position.idleGrowth = bytesOf(openedFor(file, baseline)) - read
    assert.ok(position.idleGrowth <= MiB, `Preview reads stay idle once frame ${index + 1} shows: +${position.idleGrowth} bytes in 4 s`)
    position.presented = presented('preview position ' + (index + 1), (await watchState()).preview.presented, position.time)
  }
  assert.ok(positions.every(position => position.decoder > 0 && position.decoder === positions[0].decoder), 'One pointing shows its three positions from one decoder element: ' + JSON.stringify(positions.map(position => position.decoder)))

  // A return within 1 s reuses the resident decoder and reads no index again.
  const resident = (await previewOf(file)).decoder?.index
  pointer.move(above.x, above.y); await sleep(500)
  const returnSince = Date.now(); pointer.move(positions[2].x, g.y)
  const back = await until(() => previewOf(file), state => state.frame, 1000)
  await sleep(500)
  checks.previewReturn = { awayMs: 500, frameMs: back.ms, reused: back.value.decoder?.index === resident, indexRequests: openedFor(file, returnSince).filter(entry => startOf(entry) < indexEnd).length }
  assert.ok(back.ms !== null && checks.previewReturn.reused, 'A quick return shows the frame from the same decoder: ' + JSON.stringify(checks.previewReturn))
  assert.equal(checks.previewReturn.indexRequests, 0, 'A quick return reads no index again')

  // Leaving lets the decoder go within 4 s with every preview request closed; nothing opens afterwards; main is untouched.
  pointer.move(above.x, above.y)
  const released = await until(async () => {
    const opened = openedFor(file, baseline)
    return { decoder: (await previewOf(file)).decoder !== null, requests: opened.length, open: opened.filter(entry => !entry.closed).length }
  }, state => state.requests > 0 && !state.decoder && state.open === 0, 4000)
  const phaseEnd = Date.now()
  checks.previewRelease = { ms: released.ms, ...released.value }
  assert.ok(released.ms !== null, 'Within 4 s of leaving the decoder is gone and every one of the preview requests is closed: ' + JSON.stringify(released.value))
  await sleep(4000)
  checks.previewRelease.openedAfter = openedFor(file, phaseEnd).length
  assert.equal(checks.previewRelease.openedAfter, 0, 'No preview request opens after release')
  const mainAfter = await mainOf(file)
  checks.previewMainUnchanged = { before: { currentTime: mainBefore.currentTime, paused: mainBefore.paused }, after: { currentTime: mainAfter.currentTime, paused: mainAfter.paused } }
  assert.ok(Math.abs(mainAfter.currentTime - mainBefore.currentTime) < 1e-6 && mainAfter.paused === mainBefore.paused, 'Preview reads leave main playback where it was: ' + JSON.stringify(checks.previewMainUnchanged))

  // Where each position read, against the fixture's own keyframe table.
  const previewRequests = openedFor(file, baseline, phaseEnd)
  for (const [index, position] of positions.entries()) {
    const own = openedFor(file, position.since, positions[index + 1]?.since ?? returnSince), data = own.filter(entry => startOf(entry) >= indexEnd)
    position.requests = own.map(entry => ({ start: startOf(entry), bytes: entry.bytes, status: entry.status, closed: Boolean(entry.closed) }))
    position.bytes = bytesOf(own)
    // Bytes sent against the distinct span they cover: a restarted request sends again what its predecessor already sent.
    position.distinct = 0
    for (let end = -1, spans = own.map(entry => [startOf(entry), startOf(entry) + entry.bytes]).sort((a, b) => a[0] - b[0]), i = 0; i < spans.length; i++)
      if (spans[i][1] > end) { position.distinct += spans[i][1] - Math.max(spans[i][0], end); end = spans[i][1] }
    assert.ok(data.some(entry => entry.bytes > 0), `Position ${index + 1} reads its own media data: ${JSON.stringify(position.requests)}`)
    assert.ok(startOf(data[0]) >= position.kf - MiB && startOf(data[0]) <= position.kf + 256 * KiB, `Position ${index + 1} first reads at its keyframe: ${startOf(data[0])} for ${position.kf}`)
    for (const entry of data) assert.ok(startOf(entry) >= position.from && startOf(entry) <= position.to, `Position ${index + 1} reads inside its window: ${startOf(entry)} not in [${position.from}, ${position.to}]`)
  }
  const strays = previewRequests.filter(entry => startOf(entry) >= indexEnd && !positions.some(position => startOf(entry) >= position.from && startOf(entry) <= position.to))
  assert.deepEqual(strays.map(startOf), [], 'No preview read starts outside the index and every position window')
  // Like a window, an index read may run on by one group of pictures. The bound comes from the fixture: how far the platform
  // reads ahead on opening changes from run to run.
  const indexBytes = bytesOf(previewRequests.filter(entry => startOf(entry) < indexEnd))
  checks.previewBytes = { perPosition: positions.map(position => position.bytes), index: indexBytes, indexBound: indexEnd + table.gop, total: bytesOf(previewRequests), file: size,
    beforeBaselineGrowth: sentBeforeBaseline() - sentAtBaseline, beforePositionsGrowth: bytesOf(openedBeforePositions()) - sentAtPositions }
  assert.ok(checks.previewBytes.beforeBaselineGrowth === 0 && checks.previewBytes.beforePositionsGrowth === 0,
    'Requests opened before the baseline, or before the positions were chosen, send nothing more through the preview phase: ' + JSON.stringify(checks.previewBytes))
  assert.ok(indexBytes <= checks.previewBytes.indexBound, 'Index reads stay within the index plus one group of pictures: ' + JSON.stringify(checks.previewBytes))
  assert.ok(checks.previewBytes.total < size, 'Preview reads stay below the file size: ' + JSON.stringify(checks.previewBytes))
  const failed = previewRequests.filter(entry => entry.status >= 400)
  checks.previewStatus = { requests: previewRequests.length, failed: failed.map(entry => ({ start: startOf(entry), status: entry.status })), closedBeforeReply: previewRequests.filter(entry => entry.status === 0).length }
  assert.ok(previewRequests.length > 0 && failed.length === 0, 'Preview requests were made and none is answered 4xx or 5xx: ' + JSON.stringify(checks.previewStatus))
  checks.previewPositions = positions.map(({ fraction, time, frameMs, decoder, stopMs, afterFrame, idleGrowth, bytes, distinct, requests, presented: record }) =>
    ({ fraction, time, frameMs, decoder, stopMs, afterFrame, idleGrowth, bytes, distinct, requests, presented: record }))

  // The first moment of a fresh pointing shows the time alone.
  for (let attempt = 1; ; attempt++) {
    pointer.move(pixelAt(g, 0.4), g.y); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const before = await previewOf(file); await frame('preview-first-dark', false); const after = await previewOf(file)
    if (before.unit && !before.idle && !before.frame && !after.frame && after.bubble) { checks.previewFirst = { attempt, bubble: after.bubble }; break }
    report.frames.pop()
    assert.ok(attempt < 4, 'The first moment of a pointing could be captured with the time alone: ' + JSON.stringify({ before, after }))
    await releasePreview(file, g)
  }
  await releasePreview(file, g)

  // The steps that follow run on playing main playback.
  await evaluate(`mediaPlaybackProbe.seekFraction(${q}, 0.1)`)
  assert.ok((await until(() => mainOf(file), state => arrived(state, (g.end - g.start) * 0.1, 0.05), 5000)).ms !== null, 'Main playback moves to 10%')
  await evaluate(`mediaPlaybackProbe.play(${q})`)
  assert.ok((await until(() => mainOf(file), state => !state.paused && state.currentTime > (g.end - g.start) * 0.1 + 0.3, 5000)).ms !== null, 'Main playback runs')

  // Resting on the timeline until the controls idle away lets the preview go. The rested position's decode span is still
  // unread, so its window has requests to close; the latest such keyframe sits farthest from playback.
  const readSoFar = requestsFor(file).map(entry => [startOf(entry), startOf(entry) + entry.bytes])
  const far = keysByTime.filter(key => key.time > 0).reverse().map(key => {
    const x = pixelAt(g, (key.time + 0.5) / (g.end - g.start))
    return { x, key: key.pos, ...windowAt(table, timeAt(g, x)) }
  }).find(candidate => candidate.kf === candidate.key && unread(candidate.kf, candidate.target, readSoFar))
  assert.ok(far, 'A keyframe whose decode span nobody has read is left for the idle release: ' + JSON.stringify(readSoFar))
  const farSince = Date.now()
  pointer.move(far.x, g.y)
  assert.ok((await until(() => previewOf(file), state => state.frame && arrived(state.decoder, far.time, 0.0005), 1000)).ms !== null, 'The far position shows')
  const hidden = await until(() => previewOf(file), state => state.controls === 'hidden', 6000)
  assert.ok(hidden.ms !== null, 'The controls idle away while main plays')
  // Its new decoder may read the index again; those reads close too.
  const idle = await until(async () => {
    const own = openedFor(file, farSince).filter(entry => startOf(entry) < indexEnd || (startOf(entry) >= far.from && startOf(entry) <= far.to))
    return { decoder: (await previewOf(file)).decoder !== null, requests: own.filter(entry => startOf(entry) >= indexEnd).length, index: own.filter(entry => startOf(entry) < indexEnd).length,
      open: own.filter(entry => !entry.closed).length }
  }, state => state.requests > 0 && !state.decoder && state.open === 0, 4000)
  checks.previewIdleRelease = { time: far.time, hideMs: hidden.ms, releaseMs: idle.ms, window: { from: far.from, to: far.to }, ...idle.value }
  assert.ok(idle.ms !== null, 'Within 4 s of the controls hiding the decoder is gone and every one of its window\'s requests and index reads is closed: ' + JSON.stringify(checks.previewIdleRelease))

  // While main plays, a sweep keeps one preview seek in flight on one decoder, lands on the last position, and leaves playback
  // smooth. It ends just after a keyframe, so the last seek reads and decodes little; its 1 s still includes a restarted read.
  pointer.move(above.x, above.y)
  assert.ok((await until(() => previewOf(file), state => state.controls === 'visible', 2000)).ms !== null, 'Moving over the player shows the controls')
  const end = keysByTime.filter(key => key.time > 0 && key.time + 0.5 <= (g.end - g.start) * 0.7).at(-1)
  const from = pixelAt(g, 0.3), to = pixelAt(g, (end.time + 0.5) / (g.end - g.start)), moves = 40, lastTime = timeAt(g, to)
  pointer.move(from, g.y)
  const started = await until(() => previewOf(file), state => state.frame, 3000)
  assert.ok(started.ms !== null, 'The sweep starts from a shown frame')
  // The long-task watch records: a deliberate 80 ms task, alone since the peaks were cleared, shows up before the sweep is measured afresh.
  await evaluate('mediaPlaybackProbe.resetPeaks()')
  await evaluate('mediaPlaybackProbe.busy(80)')
  const busy = await until(watchState, state => state.longTasks.some(ms => ms >= 50), 2000)
  assert.ok(busy.ms !== null, 'A deliberate 80 ms task in the page is recorded as a long task: ' + JSON.stringify(busy.value.longTasks))
  await evaluate('mediaPlaybackProbe.resetPeaks()')
  const mainStart = await mainOf(file), sweepStart = Date.now()
  for (let move = 1; move <= moves; move++) { pointer.move(from + (to - from) * move / moves, g.y); await sleep(22) }
  const sweepMs = Date.now() - sweepStart
  const stop = await until(watchState, state => state.lastMove !== null && Math.abs(state.lastMove.x - Math.round(to)) < 1, 2000)
  assert.ok(stop.ms !== null, 'The sweep\'s last move reaches the timeline: ' + JSON.stringify(stop.value.lastMove))
  const last = await until(() => previewOf(file), state => state.frame && arrived(state.decoder, lastTime, FRAME), 3000)
  const swept = await watchState(), mainEnd = await mainOf(file)
  // Seeks started by the time the last move arrived, the one still in flight then, and those started after it.
  const stopAt = stop.value.lastMove.at, seeks = swept.preview.seeks, inFlight = seeks.filter(seek => seek.at < stopAt).at(-1), afterStop = seeks.filter(seek => seek.at >= stopAt)
  const settled = inFlight?.ms == null ? stopAt : Math.max(stopAt, inFlight.at + inFlight.ms), final = afterStop.at(-1) ?? inFlight
  const shownAt = final?.ms == null ? null : final.at + final.ms, queueMs = afterStop.length ? Math.round(afterStop[0].at - settled) : null
  checks.previewSweep = { moves, ms: sweepMs, lastTime, frameMs: last.ms, maxInFlight: swept.preview.maxInFlight, seeking: swept.preview.seeking, seeked: swept.preview.seeked, seekMs: seeks.map(seek => seek.ms),
    decoders: { start: started.value.decoder?.index ?? null, end: last.value.decoder?.index ?? null },
    afterStop: { seeks: afterStop.length, inFlightMs: Math.round(settled - stopAt), queueMs, lastSeekMs: final?.ms ?? null, stopToFrameMs: shownAt === null ? null : Math.round(shownAt - stopAt) },
    presented: presented('sweep last position', swept.preview.presented, lastTime) }
  assert.ok(sweepMs <= 1500, 'The sweep takes at most 1.5 s: ' + sweepMs)
  assert.ok(last.ms !== null, 'The last swept position shows within one frame: ' + JSON.stringify(last.value))
  assert.ok(checks.previewSweep.decoders.start > 0 && checks.previewSweep.decoders.start === checks.previewSweep.decoders.end, 'The sweep keeps one decoder element: ' + JSON.stringify(checks.previewSweep.decoders))
  assert.ok(afterStop.length <= 1, 'At most one preview seek starts after the pointer stops: ' + JSON.stringify(checks.previewSweep))
  assert.ok(queueMs === null || queueMs <= 50, 'The newest time is sent within 50 ms of the seek in flight landing, or of the stop when none was: ' + JSON.stringify(checks.previewSweep))
  assert.ok(shownAt !== null && shownAt - settled <= 1000, 'The last position shows within 1 s after the seek in flight at the stop lands: ' + JSON.stringify(checks.previewSweep))
  assert.ok(swept.preview.maxInFlight <= 1 && swept.preview.seeking > 0, 'At most one preview seek is in flight during the sweep: ' + JSON.stringify(checks.previewSweep))
  checks.sweepMain = { advanced: mainEnd.currentTime - mainStart.currentTime, waiting: swept.main.waiting, longTasks: swept.longTasks, longTaskControl: busy.value.longTasks }
  assert.ok(checks.sweepMain.advanced > 0.5 && !mainEnd.paused, 'Main playback keeps advancing through the sweep: ' + JSON.stringify(checks.sweepMain))
  assert.equal(swept.main.waiting, 0, 'The sweep adds no waiting event to main playback')
  // vacuous-ok: a calm sweep records no long task; the deliberate task above proves the watch records one.
  assert.ok(swept.longTasks.every(ms => ms <= 200), 'No long task over 200 ms during the sweep: ' + JSON.stringify(swept.longTasks))

  // A held drag on a playing video: paused while held, the picture follows, release lands, playback resumes, nothing announced.
  pointer.move(above.x, above.y)
  assert.ok((await until(() => previewOf(file), state => state.controls === 'visible', 2000)).ms !== null, 'Moving over the player shows the controls')
  const pressX = pixelAt(g, 0.4), heldX = pixelAt(g, 0.6), heldTime = timeAt(g, heldX), step = (g.end - g.start) / 1000
  pointer.move(pressX, g.y); await sleep(250)
  assert.equal((await mainOf(file)).paused, false, 'The drag starts on a playing video')
  await evaluate('mediaPlaybackProbe.resetPeaks()')
  pointer.down(pressX, g.y)
  for (let move = 1; move <= 32; move++) { pointer.move(pressX + (heldX - pressX) * move / 32, g.y, true); await sleep(20) }
  const held = await until(() => mainOf(file), state => arrived(state, heldTime, step + FRAME), 1000), heldPreview = await previewOf(file)
  await frame('drag-held-dark')
  const whileHeld = await watchState()
  checks.drag = { moves: 32, heldTime, heldMs: held.ms, paused: held.value.paused, disc: held.value.disc, previewFrame: heldPreview.frame, maxInFlight: whileHeld.main.maxInFlight,
    heldPresented: presented('drag held', [whileHeld.main.presented], heldTime) }
  pointer.up(heldX, g.y)
  const landed = await until(() => mainOf(file), state => arrived(state, heldTime, step + FRAME), 1000)
  const resumed = await until(() => mainOf(file), state => !state.paused && state.currentTime > heldTime + 0.1, 3000)
  const afterDrag = await watchState()
  Object.assign(checks.drag, { landedMs: landed.ms, resumedMs: resumed.ms, announcements: afterDrag.announcements.map(entry => entry.text) })
  assert.ok(held.ms !== null && held.value.paused && !held.value.disc, 'While held the video is paused at the held position without the play disc: ' + JSON.stringify(checks.drag))
  assert.equal(heldPreview.frame, false, 'No pointed frame covers the picture while held')
  assert.ok(whileHeld.main.maxInFlight <= 1 && whileHeld.main.seeking > 0, 'At most one main seek is in flight while held: ' + JSON.stringify(checks.drag))
  assert.ok(landed.ms !== null && resumed.ms !== null, 'Release lands and playback resumes: ' + JSON.stringify(checks.drag))
  // vacuous-ok: a quiet drag announces nothing; the pause below proves the same watch hears announcements.
  assert.ok(!checks.drag.announcements.some(text => /^(Paused|Playing)$/.test(text)), 'A drag announces neither Paused nor Playing: ' + JSON.stringify(checks.drag.announcements))
  // The same watch hears a pause made outside a drag, so its silence through the drag is not an empty watch; a late Playing would show here too.
  await evaluate(`mediaPlaybackProbe.pause(${q})`)
  const announced = await until(watchState, state => state.announcements.some(entry => entry.text === 'Paused'), 2000)
  checks.drag.pauseAnnounced = announced.value.announcements.map(entry => entry.text)
  assert.deepEqual(checks.drag.pauseAnnounced, ['Paused'], 'Since the drag began, only a pause outside it is announced: ' + JSON.stringify(checks.drag.pauseAnnounced))

  // A press without moving lands on the pointed time, also on the thumb itself.
  const pointX = pixelAt(g, 0.33), pointTime = timeAt(g, pointX)
  pointer.move(pointX, g.y); await sleep(250); pointer.down(pointX, g.y); pointer.up(pointX, g.y)
  const pressed = await until(() => mainOf(file), state => arrived(state, pointTime, FRAME), 3000)
  const thumbCentre = g.left + g.thumb / 2 + (await timelineOf(file)).value / 1000 * (g.width - g.thumb)
  const onThumbX = pixelAt(g, 0, thumbCentre + 3), onThumbTime = timeAt(g, onThumbX)
  pointer.move(onThumbX, g.y); await sleep(250); pointer.down(onThumbX, g.y); pointer.up(onThumbX, g.y)
  const onThumb = await until(() => mainOf(file), state => arrived(state, onThumbTime, FRAME), 3000)
  checks.pressAccuracy = { pointed: { x: pointX, time: pointTime, ms: pressed.ms, landed: pressed.value.currentTime },
    onThumb: { x: onThumbX, thumbCentre, thumb: g.thumb, time: onThumbTime, ms: onThumb.ms, landed: onThumb.value.currentTime, presented: presented('press on the thumb', [(await watchState()).main.presented], onThumbTime) } }
  assert.ok(pressed.ms !== null, 'A press without moving lands on the pointed time: ' + JSON.stringify(checks.pressAccuracy))
  assert.ok(Math.abs(onThumbX - thumbCentre) < g.thumb / 2 && Math.abs(onThumbTime - pointTime) > FRAME, 'The second press is on the thumb and points elsewhere: ' + JSON.stringify(checks.pressAccuracy))
  assert.ok(onThumb.ms !== null, 'A press on the thumb lands on the pointed time: ' + JSON.stringify(checks.pressAccuracy))
  await releasePreview(file, g)

  // With reduced motion and reduced transparency, the end state still shows the frame and its time.
  win.webContents.debugger.attach('1.3')
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] })
    const x = pixelAt(g, 0.62), time = timeAt(g, x)
    pointer.move(x, g.y)
    const reduced = await until(() => previewOf(file), state => state.frame && arrived(state.decoder, time, 0.0005), 3000)
    checks.previewReduced = { frameMs: reduced.ms, motion: await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), transparency: await evaluate(`matchMedia('(prefers-reduced-transparency: reduce)').matches`) }
    assert.ok(reduced.ms !== null && checks.previewReduced.motion && checks.previewReduced.transparency, 'The reduced end state shows the frame: ' + JSON.stringify(checks.previewReduced))
    await frame('preview-reduced-dark')
  } finally { await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); win.webContents.debugger.detach() }
  await releasePreview(file, g)

  // A short Region shrinks the frame, here to the smallest a readable frame may be; one too short for that points at the time only.
  const [width, height] = win.getContentSize()
  const roomFor = async (target, tolerance) => {
    for (let tries = 0; tries < 6; tries++) {
      const now = await timelineOf(file)
      if (Math.abs(now.room - target) <= tolerance) return now
      const [w, h] = win.getContentSize(); win.setContentSize(w, Math.max(160, Math.round(h + target - now.room))); await sleep(500)
    }
    return await timelineOf(file)
  }
  try {
    const short = await roomFor(98, 2)
    assert.ok(short.room >= 96 && short.room <= 100, 'A short Region leaves 96 to 100 px above the timeline, just above the least room for a frame: ' + short.room)
    await evaluate(`mediaPlaybackProbe.showControls(${q})`)
    const shortX = pixelAt(short, 0.45), shortTime = timeAt(short, shortX)
    pointer.move(shortX, short.y)
    const shrunk = await until(() => previewOf(file), state => state.frame && arrived(state.decoder, shortTime, 0.0005), 3000)
    checks.previewShort = { room: short.room, frameMs: shrunk.ms, frame: shrunk.value.frameBox, box: shrunk.value.box, stage: short.stage }
    assert.ok(shrunk.ms !== null && shrunk.value.frameBox.height > 0 && shrunk.value.frameBox.height < 112, 'A short Region shows a shrunken frame: ' + JSON.stringify(checks.previewShort))
    assert.ok(shrunk.value.box.top >= short.stage.top - 0.5, 'The shrunken frame stays inside the picture: ' + JSON.stringify(checks.previewShort))
    await frame('preview-short-dark')
    await releasePreview(file, short)
    const tiny = await roomFor(70, 8)
    assert.ok(tiny.room < 96, 'A Region too short for a readable frame: ' + tiny.room)
    await evaluate(`mediaPlaybackProbe.showControls(${q})`)
    pointer.move(pixelAt(tiny, 0.45), tiny.y); await sleep(1000)
    const timeOnly = await previewOf(file)
    checks.previewTooShort = { room: tiny.room, decoder: timeOnly.decoder !== null, frame: timeOnly.frame, bubble: timeOnly.bubble, idle: timeOnly.idle }
    assert.ok(!timeOnly.decoder && !timeOnly.frame && timeOnly.bubble && !timeOnly.idle, 'Too short a Region points at the time only: ' + JSON.stringify(checks.previewTooShort))
    await frame('preview-too-short-dark')
    pointer.move(tiny.left + tiny.width / 2, tiny.stage.top + 10)
  } finally { win.setContentSize(width, height); await sleep(600) }
}

async function capture() {
  await wait(`typeof window.mediaPlaybackProbe === 'object'`)
  await wait(`Boolean(document.querySelector('.workbench-region'))`)
  // 1. The 55 MB file from the report plays. Before play, only the index is read.
  const openedAt = performance.now()
  await evaluate(`mediaPlaybackProbe.open("promo.mp4")`)
  await wait(`mediaPlaybackProbe.player("promo.mp4")?.decode === 'ready'`)
  report.checks.firstFrameMs = Math.round(performance.now() - openedAt)
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
  const seekAt = performance.now()
  // Near the end, so the far seek reads the file's last few MiB and leaves its middle unread for the preview phase.
  await evaluate(`mediaPlaybackProbe.seekFraction("promo.mp4", 0.95)`)
  await wait(`(()=>{const p=mediaPlaybackProbe.player("promo.mp4");return p&&p.currentTime>p.duration*0.94&&p.readyState>=2})()`)
  report.checks.seekReadyMs = Math.round(performance.now() - seekAt)
  const ranged = requestsFor('promo.mp4').filter(entry => entry.status === 206 && entry.range && Number(/bytes=(\d+)-/.exec(entry.range)?.[1]) > 0)
  assert.ok(ranged.length > 0, 'Seeking far reads by Range, not from the start')
  report.checks.seekRanges = ranged.map(entry => entry.range)
  // Counted before the pointing below, whose preview decoder reads the same file.
  report.checks.totalBytes = sentFor('promo.mp4')
  assert.ok(report.checks.totalBytes < size, `Watching and seeking did not read the whole file: ${report.checks.totalBytes} of ${size}`)
  // Pointed where main playback already read, so the bytes the preview phase measures stay unread.
  await evaluate(`mediaPlaybackProbe.showControls("promo.mp4")`); await evaluate(`mediaPlaybackProbe.hover("promo.mp4", 0.02)`)
  await wait(`mediaPlaybackProbe.preview("promo.mp4").frame`)
  await frame('video-controls-dark')
  const darkAccent = await evaluate(`mediaPlaybackProbe.timelineFill("promo.mp4")`)
  await evaluate(`mediaPlaybackProbe.theme("light")`); await evaluate(`mediaPlaybackProbe.showControls("promo.mp4")`); await frame('video-controls-light')
  // Over the dark scrim the played part of the timeline must stay brighter than the buffered white wash in both themes.
  const lightAccent = await evaluate(`mediaPlaybackProbe.timelineFill("promo.mp4")`)
  report.checks.timelineAccent = { dark: darkAccent, light: lightAccent }
  for (const [theme, color] of Object.entries(report.checks.timelineAccent)) assert.ok(relativeLuminance(color) > 0.7, `The ${theme} timeline fill reads on the scrim: ${color}`)
  await evaluate(`mediaPlaybackProbe.theme("dark")`)
  await evaluate(`mediaPlaybackProbe.unhover("promo.mp4")`)
  await wait(`!mediaPlaybackProbe.preview("promo.mp4").decoder`, 8000)

  // 1b. The pointed-frame preview with real pointer input.
  await previewPhase(size)

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
  // A narrow Region's pointed frame stays inside its picture.
  const ng = await timelineOf('promo.mp4'), narrowX = pixelAt(ng, 0.55), narrowTime = timeAt(ng, narrowX)
  pointer.move(narrowX, ng.y)
  const narrowFrame = await until(() => previewOf('promo.mp4'), state => state.frame && arrived(state.decoder, narrowTime, 0.0005), 3000)
  report.checks.previewNarrow = { frameMs: narrowFrame.ms, frame: narrowFrame.value.frameBox, box: narrowFrame.value.box, stage: ng.stage }
  assert.ok(narrowFrame.ms !== null, 'The narrow Region shows the pointed frame: ' + JSON.stringify(narrowFrame.value))
  assert.ok(narrowFrame.value.box.left >= ng.stage.left - 0.5 && narrowFrame.value.box.right <= ng.stage.right + 0.5, 'The narrow frame stays inside the picture: ' + JSON.stringify(report.checks.previewNarrow))
  await frame('preview-narrow-dark')
  // Near the timeline's end a frame centred on the pointer would cross the picture's side; it stays inside with the inset.
  const edgeX = pixelAt(ng, 0, ng.left + ng.width - 14), edgeTime = timeAt(ng, edgeX)
  const edgeCentre = Math.min(Math.max(edgeX, ng.left + ng.thumb / 2), ng.left + ng.width - ng.thumb / 2)
  pointer.move(edgeX, ng.y)
  const edge = await until(() => previewOf('promo.mp4'), state => state.frame && arrived(state.decoder, edgeTime, 0.0005), 3000)
  assert.ok(edge.ms !== null, 'The edge frame shows: ' + JSON.stringify(edge.value))
  const edgeBox = edge.value.box, edgeHalf = (edgeBox.right - edgeBox.left) / 2
  report.checks.previewEdge = { pointer: edgeX, unclampedRight: edgeCentre + edgeHalf, box: edgeBox, stage: { left: ng.stage.left, right: ng.stage.right }, inset: ng.inset }
  assert.ok(edgeCentre + edgeHalf > ng.stage.right - ng.inset, 'Centred on the pointer the frame would cross the side, so the clamp is exercised: ' + JSON.stringify(report.checks.previewEdge))
  assert.ok(ng.inset > 0 && edgeBox.left >= ng.stage.left + ng.inset - 0.5 && edgeBox.right <= ng.stage.right - ng.inset + 0.5, 'At an edge the frame stays inside the player with the inset: ' + JSON.stringify(report.checks.previewEdge))
  await frame('preview-edge-dark')
  await releasePreview('promo.mp4', ng)

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
  // A held drag moves an HLS list's picture and the release lands; a playlist points at the time only.
  const hls = 'hls/index.m3u8', hg = await timelineOf(hls)
  await evaluate(`mediaPlaybackProbe.watch(${JSON.stringify(hls)})`); await evaluate(`mediaPlaybackProbe.showControls(${JSON.stringify(hls)})`)
  const hlsFrom = pixelAt(hg, 0.3), hlsTo = pixelAt(hg, 0.6), hlsTime = timeAt(hg, hlsTo), hlsStep = (hg.end - hg.start) / 1000
  pointer.move(hlsFrom, hg.y); await sleep(400)
  const hlsPointing = await previewOf(hls)
  pointer.down(hlsFrom, hg.y)
  for (let move = 1; move <= 30; move++) { pointer.move(hlsFrom + (hlsTo - hlsFrom) * move / 30, hg.y, true); await sleep(20) }
  const hlsHeld = await until(() => mainOf(hls), state => arrived(state, hlsTime, hlsStep + FRAME), 5000)
  const hlsHeldPresented = presented('hls drag held', [(await watchState()).main.presented], hlsTime)
  pointer.up(hlsTo, hg.y)
  const hlsLanded = await until(() => mainOf(hls), state => arrived(state, hlsTime, hlsStep + FRAME), 5000)
  report.checks.hlsDrag = { time: hlsTime, heldMs: hlsHeld.ms, landedMs: hlsLanded.ms, landed: hlsLanded.value.currentTime, presented: hlsHeldPresented,
    pointing: { decoder: hlsPointing.decoder !== null, frame: hlsPointing.frame, bubble: hlsPointing.bubble } }
  assert.ok(hlsHeld.ms !== null && hlsLanded.ms !== null, 'An HLS drag moves the picture and lands: ' + JSON.stringify(report.checks.hlsDrag))
  assert.ok(!hlsPointing.decoder && !hlsPointing.frame && hlsPointing.bubble, 'An HLS list points at the time only: ' + JSON.stringify(report.checks.hlsDrag))
  pointer.move(hg.left + hg.width / 2, hg.stage.top + 40)
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
  report.isolation = Object.fromEntries(Object.keys(privatePaths).map(name => [name, app.getPath(name)]))
  assert.deepEqual(report.isolation, privatePaths, 'Electron keeps all four private profile paths')
  assert.equal(process.env.AGENTMUX_AGENT_SESSION_STORE, path.join(privatePaths.userData, 'agent-sessions.json'))
  assert.equal(process.env.AGENTMUX_MESSAGE_QUEUE_PATH, path.join(privatePaths.userData, 'global-messages.ndjson'))
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
