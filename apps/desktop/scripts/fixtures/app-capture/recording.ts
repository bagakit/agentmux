import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppRecording } from '../../../../../packages/core/src/app-capture.js'
import { parseAppCaptureResult } from '../../../../../packages/core/src/app-capture.js'
import { withCaptureProof, type CaptureProof } from './bootstrap.js'

const exec = promisify(execFile), delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const terminal = (state: string) => ['completed', 'partial', 'failed', 'interrupted'].includes(state)
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

async function until(context: CaptureProof, id: string, ready: (recording: AppRecording) => boolean) {
  for (let i = 0; i < 60; i++) {
    const reply = await context.cli('app.record.inspect', { operationId: id })
    assert.equal(reply.ok, true, JSON.stringify(reply))
    if (reply.result.recording && ready(reply.result.recording)) return reply.result.recording as AppRecording
    await delay(70)
  }
  throw new Error('The original recording did not reach the required observed state.')
}

async function decode(data: string) {
  const window = new BrowserWindow({ show: false, focusable: false, width: 16, height: 16,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  try {
    await window.loadURL('data:text/html,<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src data:"><body>')
    return await window.webContents.executeJavaScript(`(async () => {
      const video = document.createElement('video'), canvas = document.createElement('canvas');
      const samples = []; video.muted = true; video.src = 'data:video/webm;base64,' + ${JSON.stringify(data)};
      document.body.append(video, canvas);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Original WebM decode did not finish')), 15000);
        video.onerror = () => { clearTimeout(timer); reject(new Error('Original WebM is not decodable')); };
        video.onended = () => { clearTimeout(timer); resolve({width: video.videoWidth, height: video.videoHeight, samples}); };
        video.onloadedmetadata = async () => {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const context = canvas.getContext('2d');
          const sample = (_now, metadata) => {
            context.drawImage(video, 0, 0);
            samples.push({time: metadata.mediaTime, renderer: [...context.getImageData(100,300,1,1).data], browser: [...context.getImageData(450,300,1,1).data]});
            if (!video.ended) video.requestVideoFrameCallback(sample);
          };
          video.requestVideoFrameCallback(sample); await video.play();
        };
      });
    })()`) as { width: number; height: number; samples: { time: number; renderer: number[]; browser: number[] }[] }
  } finally { if (!window.isDestroyed()) window.destroy() }
}

async function runChild(context: CaptureProof, phase: 'crash' | 'recover') {
  const root = join(context.root, phase), profile = join(root, 'profile'), home = join(root, 'home')
  for (const directory of [home, profile, join(profile, 'appData'), join(profile, 'sessionData'), join(root, 'tmp')]) await mkdir(directory, { recursive: true })
  const launcher = join(root, 'launch.cjs'), result = join(root, 'result.json')
  await writeFile(launcher, phase === 'recover' ? `import(${JSON.stringify(pathToFileURL(process.env.AGENTMUX_RECORDING_RECOVERY_ENTRY!).href)}).catch(e=>{console.error(e);process.exitCode=1});` : `const{app}=require('electron');const p=require('node:path');
    app.setPath('home',process.env.HOME);app.setPath('appData',p.join(${JSON.stringify(profile)},'appData'));
    app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',p.join(${JSON.stringify(profile)},'sessionData'));
    import(${JSON.stringify(import.meta.url)}).catch(e=>{console.error(e);app.exit(1)});`)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ZDOTDIR: home,
    AGENTMUX_RECORDING_PROOF_PHASE: phase, AGENTMUX_RECORDING_ORIGINAL_ROOT: context.root,
    AGENTMUX_CAPTURE_PROOF_ROOT: root, AGENTMUX_CAPTURE_PROOF_RESULT: result,
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'runtime/state'),
    AGENTMUX_DESKTOP_USER_DATA: profile, AGENTMUX_SPATIAL_STATE_STORE: join(root, 'spatial.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.json'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), TMPDIR: join(root, 'tmp') }
  delete env.ELECTRON_RUN_AS_NODE
  if (phase === 'recover') env.ELECTRON_RUN_AS_NODE = '1'
  try { await exec(process.execPath, [launcher], { env, timeout: 25_000, maxBuffer: 1024 * 1024 }) }
  catch (error) {
    try {
      const report = JSON.parse(await readFile(result, 'utf8'))
      if (report.error) throw new Error(report.error)
    } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError }
    throw error
  }
  return JSON.parse(await readFile(result, 'utf8'))
}

const phase = process.env.AGENTMUX_RECORDING_PROOF_PHASE
console.error('[recording-proof] process', process.pid, phase ?? 'baseline')
if (phase === 'crash') {
  void withCaptureProof(async context => {
    console.error('[recording-proof] crash owner', process.pid)
    const started = await context.cli('app.record.start', { operationId: 'abandoned-original', target: context.target, durationMs: 60_000, fps: 8 })
    assert.equal(started.ok, true, JSON.stringify(started))
    const recording = await until(context, 'abandoned-original', record => record.state === 'recording' && record.frameCount >= 2)
    const writer = context.recordings as unknown as { save(recording: AppRecording, createOnly?: boolean): Promise<void> }
    const save = writer.save.bind(context.recordings)
    writer.save = async (published, createOnly) => {
      if (published.operationId === 'published-original' && published.state === 'completed' && published.bytes > 0) {
        // Actual artifacts were fsynced by the original production writer, but its
        // final metadata is deliberately not written before this real process exit.
        await writeFile(process.env.AGENTMUX_CAPTURE_PROOF_RESULT!, JSON.stringify({ pid: process.pid, recording, published }))
        app.exit(0)
      }
      await save(published, createOnly)
    }
    assert.equal((await context.cli('app.record.start', { operationId: 'published-original', target: context.target, durationMs: 1100, fps: 8 })).ok, true)
    const published = await until(context, 'published-original', record => ['completed', 'failed', 'interrupted'].includes(record.state))
    assert.equal(published.state, 'completed', 'The actual publication boundary must have encoded original bytes')
    // The parent observes this exact process exit with its bounded worker budget.
    await new Promise<void>(() => {})
  })
} else {
  void withCaptureProof(async context => {
    console.error('[recording-proof] source ready', process.pid)
    const windowCount = BrowserWindow.getAllWindows().length
    await context.window.webContents.executeJavaScript(`globalThis.__recordingPaint=setInterval(()=>{
      globalThis.__paintCount=(globalThis.__paintCount||0)+1;
      document.getElementById('region').style.background=globalThis.__paintCount%2?'rgb(220,30,70)':'rgb(25,190,70)';
    },150)`)
    const input = { operationId: 'moving-workface', target: context.target, durationMs: 2200, fps: 8 }
    const start = await context.cli('app.record.start', input)
    assert.equal(start.ok, true, JSON.stringify(start))
    const duplicate = await context.cli('app.record.start', input)
    assert.equal(duplicate.ok, true, JSON.stringify(duplicate))
    assert.equal(duplicate.result.recording.requestedAt, start.result.recording.requestedAt, 'Repeated start observes the original recording')
    const conflict = await context.cli('app.record.start', { ...input, fps: 7 })
    assert.equal(conflict.ok, false, 'recording operation must retain its original intent')
    assert.equal(conflict.error.code, 'APP_RECORDING_OPERATION_CONFLICT', 'recording operation must retain its original intent')
    await assert.rejects(context.server.callRpc('app.record.inspect', { operationId: input.operationId },
      { principal: { kind: 'user', id: 'different-recording-actor' } }), { code: 'CONTROL_PERMISSION_DENIED' }, 'recording original actor must be enforced')
    const completed = await until(context, input.operationId, record => terminal(record.state))
    console.error('[recording-proof] encoded', process.pid, completed.state, completed.frameCount)
    assert.equal(completed.state, 'completed', JSON.stringify(completed)); assert.ok(completed.frameCount >= 3)
    const file = join(context.root, 'recording.webm'), read = await context.cli('app.record.read', { operationId: input.operationId }, file)
    assert.equal(read.ok, true, JSON.stringify(read))
    const video = await readFile(file)
    assert.equal(hash(video), completed.sha256); assert.equal(read.result.frames.length, completed.frameCount)
    const originalBody = await context.recordings.call('app.record.read', { operationId: input.operationId },
      { actor: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` } })
    const changedBytes = Buffer.from(video); changedBytes[changedBytes.length - 1] = changedBytes[changedBytes.length - 1]! ^ 1
    assert.throws(() => parseAppCaptureResult('app.record.read', { ...originalBody,
      video: { format: 'webm', data: changedBytes.toString('base64') } }, { operationId: input.operationId }),
    { code: 'CONTROL_PROTOCOL_ERROR' }, 'SDK WebM checksum must reject changed original bytes')
    assert.ok(read.result.frames.every((frame: any, i: number, frames: any[]) => frame.startedAt <= frame.observedAt && (!i || frame.startedAt >= frames[i - 1].observedAt)))
    const decoded = await decode(video.toString('base64'))
    console.error('[recording-proof] decoded', process.pid, decoded.samples.length)
    assert.equal(decoded.width, completed.width); assert.equal(decoded.height, completed.height)
    assert.ok(decoded.samples.length >= 3, 'recording output must decode multiple changing Renderer colors')
    assert.ok(decoded.samples.some(sample => sample.renderer[0]! > 150 && sample.renderer[1]! < 100) &&
      decoded.samples.some(sample => sample.renderer[1]! > 120 && sample.renderer[0]! < 100), 'recording output must decode multiple changing Renderer colors')
    assert.ok(decoded.samples.every(sample => Math.abs(sample.browser[0]! - 20) < 25 && Math.abs(sample.browser[1]! - 80) < 25 && sample.browser[2]! > 180), 'The native Browser child appears in the actual video')
    const repeatedRead = await context.cli('app.record.read', { operationId: input.operationId }, file)
    assert.equal(repeatedRead.ok, false, 'Export cannot overwrite a preexisting local file')
    assert.equal(hash(await readFile(file)), completed.sha256)
    context.report.webm = video.toString('base64'); context.report.video = { recording: completed, decoded }
    const timings = read.result.frames.map((frame: any) => frame.observedAt - frame.startedAt).sort((a: number, b: number) => a - b)
    context.report.cost = { requestedFps: input.fps, capturedFrames: completed.frameCount, decodedFrames: decoded.samples.length,
      elapsedMs: completed.finishedAt! - completed.startedAt!, firstCaptureAt: read.result.frames[0].startedAt,
      lastCaptureAt: read.result.frames.at(-1).observedAt, captureMedianMs: timings[Math.floor(timings.length / 2)], captureMaxMs: timings.at(-1) }
    context.report.checks.push('actual-cli-start-inspect-read', 'real-Chromium-WebM-decode', 'Renderer-and-native-Browser-pixels', 'original-intent-and-actor', 'new-file-only-export', 'SDK-original-WebM-checksum')

    const stopInput = { operationId: 'stop-original', target: context.target, durationMs: 6000, fps: 8 }
    assert.equal((await context.cli('app.record.start', stopInput)).ok, true)
    await until(context, stopInput.operationId, record => record.state === 'recording' && record.frameCount >= 2)
    const stopped = await context.cli('app.record.stop', { operationId: stopInput.operationId })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    const stoppedRecord = terminal(stopped.result.recording.state) ? stopped.result.recording : await until(context, stopInput.operationId, record => terminal(record.state))
    assert.equal(stoppedRecord.state, 'completed')
    assert.ok(stoppedRecord.finishedAt - stoppedRecord.startedAt < stopInput.durationMs - 1500, 'recording stop must end the original sampler early')
    const stoppedCount = stoppedRecord.frameCount
    await delay(250)
    assert.equal((await context.cli('app.record.inspect', { operationId: stopInput.operationId })).result.recording.frameCount, stoppedCount, 'No sampling remains after original stop')

    const sourceLoss = { operationId: 'source-lost-original', target: context.target, durationMs: 6000, fps: 8 }
    assert.equal((await context.cli('app.record.start', sourceLoss)).ok, true)
    await until(context, sourceLoss.operationId, record => record.state === 'recording' && record.frameCount >= 2)
    context.window.hide()
    const lost = await until(context, sourceLoss.operationId, record => terminal(record.state))
    assert.equal(lost.state, 'failed'); assert.ok(lost.bytes > 0, 'Source failure preserves already encoded original frames')
    assert.equal((await context.cli('app.record.read', { operationId: sourceLoss.operationId }, join(context.root, 'partial.webm'))).ok, true)
    context.window.showInactive()
    await context.window.webContents.executeJavaScript('clearInterval(globalThis.__recordingPaint)')
    assert.equal(await context.window.webContents.executeJavaScript('document.getElementById("draft").value'), 'unsent original draft')
    assert.equal(BrowserWindow.getAllWindows().length, windowCount, 'Every recording/decoder sandbox is released')
    context.report.checks.push('explicit-stop-and-sampler-release', 'source-failure-keeps-partial-frames', 'draft-and-native-page-retained', 'encoder-sandboxes-released')

    console.error('[recording-proof] restarting private owners', process.pid)
    const crashed = await runChild(context, 'crash'), recovered = await runChild(context, 'recover')
    assert.notEqual(crashed.pid, process.pid); assert.notEqual(recovered.pid, process.pid); assert.notEqual(crashed.pid, recovered.pid)
    assert.equal(recovered.passed, true, recovered.error)
    assert.equal(recovered.completedOriginal.sha256, completed.sha256)
    assert.equal(recovered.interruptedOriginal.operationId, crashed.recording.operationId)
    assert.deepEqual(recovered.interruptedOriginal.target, crashed.recording.target)
    context.report.recovery = recovered; context.report.checks.push('real-process-restart-retains-originals')
  })
}
