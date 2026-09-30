import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { webContents } from 'electron'
import type { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserCdpSession } from '../../../src/main/browser-cdp-session.js'
import { discoverBrowserFrameDocuments } from '../../../src/main/browser-frame-documents.js'
import { inspectFeedbackFrame } from './frame-pixels.mjs'

type Context = {
  manager: BrowserViewManager; contents: Electron.WebContents; id: string; operator: { id: string; name: string }
  phase: string; out: string; url: string; retainedFile: string; receipt: any; created: any; retained: any
  stateExpression: string; pageState(contents: Electron.WebContents): Promise<any>
  action(contents: Electron.WebContents, label: string, method: 'click' | 'hover' | 'fillInput', name: string): Promise<any>
  inspectTarget(contents: Electron.WebContents, target: any, evidence: any, requireCue?: boolean): Promise<any>
  nativePage(contents: Electron.WebContents, label: string): Promise<any>; osWindow(label: string): Promise<void>
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) // Fixture observation only; never in an action script.
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const point = (transform: string) => {
  const m = /^translate\(([-\d.]+)px,\s*([-\d.]+)px\)$/.exec(transform)
  assert.ok(m, 'Read actual two-dimensional production animation keyframes')
  return { x: Number(m[1]), y: Number(m[2]) }
}
const distance = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y)
const moving = (sample: any) => sample.hud?.pointer?.animations?.some((a: any) => a.currentTime > 0 && a.currentTime < a.duration)
const settled = (sample: any) => Array.isArray(sample.hud?.pointer?.animations) && sample.hud.pointer.animations.length === 0

/** Test-only observation. Original CDP promises/results are returned untouched; no action awaits a reader or frame. */
export async function runMotionProbe(c: Context): Promise<void> {
  const { contents, manager, receipt } = c
  const frameBindingOnly = process.env.AGENTMUX_FEEDBACK_FRAME_BINDING_ONLY === '1'
  const previousPngBytes = c.phase === 'second' ? JSON.parse(await readFile(join(c.out, 'first-receipt.json'), 'utf8')).motion.nativePngBytes : 0
  receipt.motion = { schema: 'agentmux.browser-feedback-motion.v2', scope: frameBindingOnly ? 'T-024-private-native-frame-binding-increment' : 'T-024-private-native-increment',
    observationOnlyPolling: true, pollMs: 8, compositorWindowMs: 260, hoverWindowMs: 650, nativeFrames: [], caseIndices: [],
    heldActions: false, actionScriptSleeps: 0, foregroundCalls: [], systemMouseCalls: [], nativePngBytes: 0, previousPngBytes,
    forbiddenCallsBasis: 'Harness Source audit; private WebContents focus is measured below, global OS focus is not certified.',
    boundary: 'Actual action steps and transport return are separate. This does not certify Desktop/healthy Core Run/OS focus.' }
  const motion = receipt.motion
  const script = (names: string[], method = 'hover', key?: string) => `const s=await snapshot();const names=${JSON.stringify(names)};const nodes=names.map(name=>{const n=s.nodes.find(n=>n.name===name);if(!n)throw new Error('Original control missing');return n});for(const n of nodes)await ${method}(n.ref${key ? ',' + JSON.stringify(key) : ''});return {nodes,navigationId:s.navigationId}`

  async function observe(label: string, code: string, cameraMs = 260): Promise<any> {
    const row: any = { label, passed: false, heldAction: false, actionScriptSleep: false, startedAt: Date.now(),
      nativeFocusBefore: webContents.getFocusedWebContents()?.id ?? null, targets: [], preTargetSamples: [], samples: [], topSamples: [], frames: [], observationErrors: [],
      frameCapture: { received: 0, saved: 0, skipped: 0 }, skippedFrames: [], unmatchedSamples: [], opaquePayloads: [], cameraWindows: [] }
    motion.caseIndices.push({ index: receipt.cases.length, label }); receipt.cases.push(row)
    const originalSend = contents.debugger.sendCommand
    const send = originalSend.bind(contents.debugger)
    const contexts = new Map<number, any>(), handles = new Map<string, any>()
    let observing = true, operationId: string | undefined, latest: any, sampleNumber = 0, observeTop = false
    let reader: BrowserCdpSession | undefined, readerContext: any, readerAttempted = false
    let subscribed = false, cameraTimer: ReturnType<typeof setTimeout> | undefined, cameraWindow: any
    const frames: { bytes: Buffer; row: any }[] = [], pendingReads: Promise<unknown>[] = []
    const selected = new Map<string, any>()
    const primeCounts = new Map<string, number>()
    const selectFrame = (at: number): { kinds: string[]; owner: any; update(): void } | string => {
      const hud = latest?.hud
      if (cameraWindow.matchingAt === null) return 'no-first-matching-window-sample'
      if (!hud?.hostConnected || (!hud.pointer && !hud.executor)) return 'no-current-pointer-or-executor'
      if (at - latest.returnedAt < 0 || at - latest.returnedAt > 40) return 'geometry-sample-not-current'
      if (!Number.isFinite(hud.now) || at - hud.now < 0 || at - hud.now > 40) return 'dom-reading-not-current'
      if (latest.sampleKind === 'top' && cameraWindow.opaquePayloadIndex !== undefined) {
        const payload = row.opaquePayloads[cameraWindow.opaquePayloadIndex].payload
        if (hud.operationId !== payload.operationId || hud.navigationId !== payload.navigationId || hud.token !== payload.token || hud.phase !== payload.phase)
          return 'opaque-original-payload-phase-mismatch'
      }
      const key = `${hud.operationId}:${hud.navigationId}:${hud.token}`
      const owner = { operationId: hud.operationId, navigationId: hud.navigationId, token: hud.token }
      const prior = selected.get(key) ?? { intermediate: 0, sequences: new Set<number>() }
      const save = (kinds: string[], update: () => void) => ({ kinds, owner, update: () => { update(); selected.set(key, prior) } })
      if (latest.originalTarget?.method === 'pressKey') {
        if (!hud.label?.text?.trim()) return 'actual-key-label-empty'
        if (!['running', 'completed'].includes(hud.phase)) return 'key-not-active-or-completed'
        const witness = `key-${hud.phase}`
        if (prior[witness]) return 'key-phase-already-preserved'
        return save([witness], () => { prior[witness] = true }) // A real key cue is valid during tween or at zero movement.
      }
      if (hud.executor) {
        if (!['running', 'completed'].includes(hud.phase)) return 'executor-not-active-or-completed'
        if (prior[hud.phase]) return 'executor-phase-already-preserved'
        return save([`executor-${hud.phase}`], () => { prior[hud.phase] = true })
      }
      if (moving(latest)) {
        const animation = hud.pointer.animations.find((a: any) => a.currentTime > 0 && a.currentTime < a.duration)
        const from = point(animation.keyframes[0].transform), to = point(animation.keyframes.at(-1).transform)
        if (distance(hud.pointer.rect, from) <= 1 || distance(hud.pointer.rect, to) <= 1) return 'motion-endpoint-not-intermediate'
        if (prior.intermediate >= 2 || prior.sequences.has(latest.sequence)) return 'motion-intermediate-already-preserved'
        return save(['motion-intermediate'], () => { prior.intermediate++; prior.sequences.add(latest.sequence) })
      }
      if (!settled(latest)) return 'pointer-animation-not-settled'
      if (hud.phase === 'completed') {
        const floats = hud.arrow && hud.arrow.animationName !== 'none' && !hud.reducedMotion
        if (!prior.completed) return save(floats ? ['target-completed', 'hover-float-origin'] : ['target-completed'], () => {
          prior.completed = true; if (floats) prior.floatY = hud.arrow.rect.y
        })
        if (floats && !prior.floatProgress && Math.abs(hud.arrow.rect.y - prior.floatY) > 0.3)
          return save(['hover-float-progress'], () => { prior.floatProgress = true })
        return 'target-completion-or-float-already-preserved'
      }
      if (prior.running) return 'target-running-already-preserved'
      return save(['target-running'], () => { prior.running = true })
    }
    const skipFrame = (at: number, reason: string) => {
      row.frameCapture.skipped++
      row.skippedFrames.push({ captureCallbackAt: at, reason, sampleKind: latest?.sampleKind ?? null, sampleSequence: latest?.sequence ?? null })
    }
    const stopCamera = () => {
      if (subscribed) { contents.endFrameSubscription(); subscribed = false; cameraWindow.stoppedAt = Date.now() }
      clearTimeout(cameraTimer); cameraTimer = undefined
    }
    const startCamera = (opaquePayloadIndex?: number) => {
      if (motion.captureBudgetExhausted) return
      if (subscribed) {
        if (opaquePayloadIndex === undefined) return
        const next = row.opaquePayloads[opaquePayloadIndex].payload
        const previous = row.opaquePayloads[cameraWindow.opaquePayloadIndex]?.payload
        if (previous && next.operationId === previous.operationId && next.navigationId === previous.navigationId && next.token === previous.token && next.phase === previous.phase) return
        stopCamera() // A genuine product phase has its own fixed window; an old running read cannot start completed evidence.
      }
      row.compositorSubscribedAt = Date.now(); row.compositorDeadline = null; subscribed = true
      cameraWindow = { preSendAt: row.compositorSubscribedAt, subscribedAt: row.compositorSubscribedAt, budgetMs: cameraMs,
        matchingAt: null, deadline: null, ...(opaquePayloadIndex === undefined ? {} : { opaquePayloadIndex }) }
      row.cameraWindows.push(cameraWindow)
      contents.beginFrameSubscription(false, (image, dirtyRect) => {
        const at = Date.now(); row.frameCapture.received++
        if (cameraWindow.deadline !== null && at > cameraWindow.deadline) {
          skipFrame(at, 'outside-fixed-evidence-window'); stopCamera(); return
        }
        let selectedFrame: ReturnType<typeof selectFrame>
        try { selectedFrame = selectFrame(at) } catch (error: any) {
          row.observationErrors.push({ at, message: error.message }); skipFrame(at, 'actual-animation-unreadable'); return
        }
        if (typeof selectedFrame === 'string') { skipFrame(at, selectedFrame); return } // Do not encode irrelevant/cached presentations.
        const size = image.getSize(), bitmap = { ...size, bytes: image.toBitmap(), order: 'bgra' }
        const pixelEvidence = inspectFeedbackFrame(bitmap, latest)
        if ('reason' in pixelEvidence) { skipFrame(at, pixelEvidence.reason); return } // A nearby DOM read cannot make a cached blank/running image a completed witness.
        const bytes = image.toPNG()
        if (previousPngBytes + motion.nativePngBytes + bytes.length > 4 * 1024 * 1024) {
          motion.captureBudgetExhausted = true; row.captureBudgetExhausted = { at, nextFrameBytes: bytes.length }
          skipFrame(at, 'hard-png-budget'); stopCamera(); return // Stop new visual work at the hard bound; the original action still runs.
        }
        selectedFrame.update(); row.frameCapture.saved++
        motion.nativePngBytes += bytes.length
        const frame = { sequence: frames.length, captureCallbackAt: at, compositorPresentationAt: null, dirtyRect, size, webContentsId: contents.id,
          bytes: bytes.length, sha256: hash(bytes), witnessKinds: selectedFrame.kinds, candidateOwner: selectedFrame.owner, pixelEvidence,
          sampleAtOrBefore: { sampleKind: latest.sampleKind, sampleSequence: latest.sequence, returnedAt: latest.returnedAt, lagMs: at - latest.returnedAt },
          source: 'original-webcontents-beginFrameSubscription-full-compositor-frame',
          sampleBinding: 'Candidate readonly observation only; cue/phase compatibility is recomputed from original pixels. Callback time is not a presentation timestamp.' }
        frames.push({ bytes, row: frame })
      })
    }
    function primeMatchingSample(sample: any): void {
      const hud = sample.hud
      if (!subscribed || !hud?.hostConnected || (!hud.pointer && !hud.executor)) return
      const refusalReasons: string[] = []
      if (!Number.isFinite(hud.now) || Date.now() - hud.now < 0 || Date.now() - hud.now > 40) refusalReasons.push('dom-reading-not-current')
      if (sample.sampleKind === 'top') {
        const payload = row.opaquePayloads[cameraWindow.opaquePayloadIndex]?.payload
        if (!payload || hud.operationId !== payload.operationId || hud.navigationId !== payload.navigationId || hud.token !== payload.token || hud.phase !== payload.phase)
          refusalReasons.push('opaque-original-payload-phase-mismatch')
      }
      if (refusalReasons.length) { sample.matchingRefusalReasons = refusalReasons; return } // Preserve the original stale read without consuming it.
      if (cameraWindow.matchingAt === null) {
        cameraWindow.matchingAt = sample.returnedAt; cameraWindow.firstMatchingSample = { kind: sample.sampleKind, sequence: sample.sequence }
        cameraWindow.firstMatchingDelayMs = sample.returnedAt - cameraWindow.preSendAt
        cameraWindow.evidenceStartedAt = Date.now()
        cameraWindow.deadline = sample.returnedAt + cameraMs
      }
      if (hud.expiresAt > 0) cameraWindow.deadline = Math.min(cameraWindow.deadline, hud.expiresAt)
      cameraWindow.observedCueExpiresAt = hud.expiresAt
      row.compositorDeadline = cameraWindow.deadline
      clearTimeout(cameraTimer); cameraTimer = setTimeout(stopCamera, Math.max(0, cameraWindow.deadline - Date.now()))
      if (Date.now() >= cameraWindow.deadline) return
      const witness = sample.originalTarget?.method === 'pressKey' ? `key-${hud.phase}` : hud.executor ? `executor-${hud.phase}` : settled(sample)
        ? hud.arrow && hud.arrow.animationName !== 'none' && !hud.reducedMotion ? 'hover-float' : 'pointer-static' : 'pointer-motion'
      const key = `${hud.operationId}:${hud.navigationId}:${hud.token}:${witness}`
      const count = primeCounts.get(key) ?? 0
      if (count >= 2) return
      // First matching read wakes the original surface; a second is only for a still-missing actual witness.
      if (count > 0 && typeof selectFrame(Date.now()) === 'string') return
      primeCounts.set(key, count + 1)
      const prime: any = { startedAt: Date.now(), witness, ordinal: count + 1,
        sample: { kind: sample.sampleKind, sequence: sample.sequence, returnedAt: sample.returnedAt },
        owner: { operationId: hud.operationId, navigationId: hud.navigationId, token: hud.token },
        deadline: cameraWindow.deadline, stayHidden: true, stayAwake: true,
        source: 'async-original-page-prime-after-actual-matching-hud-no-dispatch-await' }
      row.compositorPrimes ??= []; row.compositorPrimes.push(prime)
      pendingReads.push(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }).then(image => {
        Object.assign(prime, { returnedAt: Date.now(), size: image.getSize(), empty: image.isEmpty() }) // No second PNG encoding.
      }).catch((error: any) => { prime.failure = { at: Date.now(), message: error.message }; row.observationErrors.push(prime.failure) }))
    }
    async function readTarget(target: any, actual: any, sampleOrigin: string): Promise<void> {
      const startedAt = Date.now()
      const response: any = await actual.send('Runtime.evaluate', { contextId: actual.contextId, expression: c.stateExpression, returnByValue: true })
      assert.equal(response.exceptionDetails, undefined)
      const sample = { sequence: ++sampleNumber, sampleKind: 'target', sampleOrigin, startedAt, returnedAt: Date.now(), originalTarget: target,
        currentContext: { frameId: actual.frameId, contextId: actual.contextId, sessionId: actual.sessionId, owner: actual.owner }, hud: response.result?.value }
      if (sample.hud?.token === target.token && sample.hud.operationId === target.operationId && sample.hud.navigationId === target.issuedNavigationId) {
        row.samples.push(sample)
        if (target.token === row.targets.at(-1)?.token) { latest = sample; primeMatchingSample(sample) }
      } else row.unmatchedSamples.push(sample) // Retain every actual read, including a replaced/expired owner.
    }
    contents.debugger.sendCommand = ((command: string, parameters: any = {}, sessionId?: string) => {
      const incoming = parameters.arguments?.[0]?.value
      if (command === 'Runtime.callFunctionOn' && incoming?.kind === 'target' && incoming.phase === 'running') {
        startCamera()
        const actualContext = handles.get(parameters.objectId)
        if (actualContext) {
          const startedAt = Date.now()
          // Queue a real readonly document observation, but never await it before returning the original action promise.
          pendingReads.push(send('Runtime.evaluate', { contextId: actualContext.contextId, expression: c.stateExpression, returnByValue: true }, sessionId)
            .then((response: any) => { row.preTargetSamples.push({ incomingToken: incoming.token, actualContext, startedAt, returnedAt: Date.now(),
              hud: response.result?.value, exceptionDetails: response.exceptionDetails }) }).catch((error: any) => row.observationErrors.push({ at: Date.now(), message: error.message })))
        }
      }
      const work = send(command, parameters, sessionId)
      void work.then((result: any) => {
        if (command === 'Page.getFrameTree' && result.frameTree?.frame?.id) row.actualMainFrameId = result.frameTree.frame.id
        if (command === 'Page.createIsolatedWorld' && parameters.worldName === 'agentmux-browser-operation-feedback')
          contexts.set(result.executionContextId, { frameId: parameters.frameId, contextId: result.executionContextId, sessionId })
        if (command === 'DOM.resolveNode' && result.object?.objectId && contexts.has(parameters.executionContextId))
          handles.set(result.object.objectId, { ...contexts.get(parameters.executionContextId), backendNodeId: parameters.backendNodeId })
        const p = parameters.arguments?.[0]?.value
        if (command === 'Runtime.callFunctionOn' && p?.kind === 'target' && p.phase === 'running' && p.operationId === operationId && handles.has(parameters.objectId)) {
          const target = { ...handles.get(parameters.objectId), issuedNavigationId: p.navigationId, operationId: p.operationId,
            token: p.token, method: p.method, keyLabel: p.keyLabel, originalSendCompletedAt: Date.now() }
          row.targets.push(target)
          // Observe this exact newly injected token immediately, before normal product detach; do not await the reader in dispatch.
          pendingReads.push(readTarget(target, { ...target, owner: 'actual-original-product-sender',
            send: (method: string, parameters: any) => send(method, parameters, target.sessionId) }, 'actual-payload-post-injection-read')
            .catch((error: any) => row.observationErrors.push({ at: Date.now(), message: error.message })))
        }
      }).catch(() => {})
      return work
    }) as any
    const originalWorld = contents.executeJavaScriptInIsolatedWorld
    contents.executeJavaScriptInIsolatedWorld = ((world: number, scripts: any[], ...rest: any[]) => {
      // Parse only the actual serialized product payload; do not execute a second feedback body.
      if (world === 1209) for (const source of scripts) {
        const start = source.code.lastIndexOf(')(')
        if (start >= 0) {
          try {
            const p = JSON.parse(source.code.slice(start + 2, -1))
            if (['js', 'cdp'].includes(p.method)) {
              row.opaquePayloads.push({ issuedAt: Date.now(), worldId: 1209, webContentsId: contents.id, payload: p })
              if (['running', 'completed'].includes(p.phase)) { observeTop = true; startCamera(row.opaquePayloads.length - 1) }
            }
          }
          catch { /* Non-feedback Electron execution is not relabelled as operation work. */ }
        }
      }
      return originalWorld.call(contents, world, scripts, ...rest)
    }) as any
    const sampler = (async () => {
      while (observing) {
        const target = row.targets.at(-1)
        try {
          if (target) {
            if (!contents.debugger.isAttached() && !readerAttempted) {
              readerAttempted = true
              reader = BrowserCdpSession.attach(contents); await reader.sendCommand('Page.enable')
              const documents = await discoverBrowserFrameDocuments(reader.sendCommand, reader.frames)
              const actual = documents.documents.find(document => document.frameId === target.frameId)
              assert.ok(actual, 'Fresh readonly observation reacquires the exact original target document after normal detach')
              const world: any = await actual.sendCommand('Page.createIsolatedWorld', { frameId: actual.frameId, worldName: 'agentmux-browser-operation-feedback' })
              readerContext = { frameId: actual.frameId, contextId: world.executionContextId, sessionId: actual.sessionId,
                send: actual.sendCommand, owner: 'fresh-readonly-observer-after-normal-product-detach' }
            }
            if (contents.debugger.isAttached()) {
              const actual = readerContext ?? { ...target, owner: 'actual-original-product-sender', send: (method: string, parameters: any) => send(method, parameters, target.sessionId) }
              await readTarget(target, actual, 'fixture-readonly-poll')
            }
          }
          // Electron world 1209 requires no debugger; completed executor can be read after normal detach.
          if (observeTop) {
            const topStartedAt = Date.now(), hud = await c.pageState(contents)
            const sample = { sequence: ++sampleNumber, sampleKind: 'top', startedAt: topStartedAt, returnedAt: Date.now(),
              webContentsId: contents.id, worldId: 1209, source: 'actual-original-webcontents-isolated-world-read', hud }
            row.topSamples.push(sample)
            const payload = row.opaquePayloads.at(-1)?.payload
            if (payload && hud?.operationId === payload.operationId && hud.navigationId === payload.navigationId && hud.token === payload.token) {
              latest = sample; primeMatchingSample(sample)
            }
          }
        } catch (error: any) { row.observationErrors.push({ at: Date.now(), originalDebuggerAttached: contents.debugger.isAttached(), message: error.message }) }
        await pause(8)
      }
    })()
    try {
      row.actualReport = await manager.runScript(c.id, code, c.operator, undefined, undefined, op => { operationId = op.id; row.operationStarted = { id: op.id, at: op.startedAt } })
      row.reportReturnedAt = Date.now(); row.actualOperationCompletedAt = row.actualReport.runOperation?.finishedAt ?? null
      row.actualActionSteps = row.actualReport.runOperation?.steps?.filter((step: any) => ['hover', 'pressKey', 'js', 'cdp'].includes(step.method)) ?? []
      assert.equal(row.actualReport.outcome.kind, 'completed')
      assert.ok(row.actualActionSteps.length > 0, 'Use the actual nonempty Main step report')
      // The real RPC time above is fixed. Only the test camera/reader continues through its original local window.
      while (subscribed && Date.now() < row.compositorDeadline) await pause(8)
    } finally {
      observing = false; await sampler; await Promise.allSettled(pendingReads)
      clearTimeout(cameraTimer); stopCamera()
      reader?.detach()
      contents.debugger.sendCommand = originalSend; contents.executeJavaScriptInIsolatedWorld = originalWorld
      for (const frame of frames) {
        const path = join(c.out, `${c.phase}-${label}-frame-${String(frame.row.sequence).padStart(3, '0')}.png`)
        await writeFile(path, frame.bytes); frame.row.path = path
        row.frames.push(frame.row); motion.nativeFrames.push(frame.row)
      }
    }
    row.nativeFocusAfter = webContents.getFocusedWebContents()?.id ?? null
    assert.ok(row.frames.length > 0, 'Actual compositor PNG sequence must be nonempty')
    assert.ok(!row.captureBudgetExhausted && !motion.captureBudgetExhausted, 'Required Native frames were not lost at the hard capture bound')
    assert.equal(row.nativeFocusAfter, row.nativeFocusBefore, 'This probe performs no native focus activation')
    return row
  }

  function movement(row: any, targetIndex: number) {
    const target = row.targets[targetIndex]; assert.ok(target, 'Actual target injection exists')
    const samples = row.samples.filter((s: any) => s.hud?.token === target.token && moving(s))
    assert.ok(samples.length >= 2, 'At least two actual in-progress BCR readings, not only endpoint metadata')
    const step = row.actualActionSteps.filter((s: any) => s.method === target.method)[targetIndex]
    assert.ok(step?.finishedAt, 'The original action has an actual finished step')
    const afterAction = samples.filter((s: any) => s.startedAt > step.finishedAt)
    assert.ok(afterAction.length > 0, 'Actual action completed while local animation remained in progress')
    const a = samples[0].hud.pointer.animations[0], from = point(a.keyframes[0].transform), to = point(a.keyframes.at(-1).transform)
    assert.ok(distance(from, to) > 4)
    const intermediate = samples.filter((s: any) => distance(s.hud.pointer.rect, from) > 1 && distance(s.hud.pointer.rect, to) > 1)
    assert.ok(intermediate.length >= 2)
    const sampleIds = new Set(intermediate.map((s: any) => s.sequence))
    const nativeFrames = row.frames.filter((f: any) => sampleIds.has(f.sampleAtOrBefore?.sampleSequence) && f.pixelEvidence?.compatible &&
      f.pixelEvidence.arrowPixels && f.candidateOwner.token === target.token)
    assert.ok(nativeFrames.length >= 2, 'Real independent compositor frames accompany intermediate geometry')
    assert.ok(new Set(nativeFrames.map((f: any) => f.sha256)).size >= 2, 'Actual intermediate original images change')
    const painted = nativeFrames.map((f: any) => f.pixelEvidence.arrowPixels.cssBounds)
    assert.ok(painted.some((p: any) => painted.some((q: any) => distance(p, q) > 1)), 'The original painted arrow moves; changed page pixels alone cannot prove movement')
    row.motionWitnesses ??= []; row.motionWitnesses.push({ targetIndex, target, actualStep: step, from, to,
      intermediateSampleSequences: intermediate.map((s: any) => s.sequence), nativeFrameSequences: nativeFrames.map((f: any) => f.sequence),
      actionFinishedBeforeAnimation: true, operationFinishedBeforeAnimation: samples.some((s: any) => row.actualOperationCompletedAt && row.actualOperationCompletedAt < s.startedAt),
      transportReturnedBeforeAnimation: samples.some((s: any) => row.reportReturnedAt < s.startedAt) })
    return { from, to }
  }
  async function available(label: string, work: () => Promise<void>) {
    try { await work(); const row = receipt.cases.findLast((r: any) => r.label === label); if (row) row.passed = true }
    catch (error: any) {
      const row = receipt.cases.findLast((r: any) => r.label === label) ?? { label }
      if (!receipt.cases.includes(row)) receipt.cases.push(row)
      Object.assign(row, { passed: false, executed: true, failure: { message: error.message, stack: error.stack } })
    }
  }
  if (c.phase === 'second') {
    assert.equal(c.created.profileId, c.retained.profileId); assert.equal(contents.getURL(), c.retained.url)
    const profileClicks = await contents.executeJavaScript('localStorage.getItem("proofClicks")')
    assert.equal(profileClicks, c.retained.profileClicks)
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    receipt.restored = { browserId: c.id, profileId: c.created.profileId, url: contents.getURL(), profileClicks, oldHudPresent: false,
      localBrowserInputRestored: true, desktopTabRegionFocusRestore: 'not-tested', healthyCoreRunRestore: 'not-tested' }
    await available('motion-reduced-static', async () => {
      const row = await observe('motion-reduced-static', script(['Continue', 'Page note']))
      assert.equal(row.targets.length, 2)
      const samples = row.samples.filter((s: any) => s.hud?.pointer)
      assert.ok(samples.length > 0)
      assert.equal(samples.some((s: any) => moving(s)), false)
      assert.equal(samples.some((s: any) => !s.hud.reducedMotion || s.hud.arrow?.animationName !== 'none'), false)
      row.passed = true
    })
  } else {
    await available('motion-same-operation', async () => { const row = await observe('motion-same-operation', script(['Continue', 'Page note']));
      assert.equal(row.targets.length, 2); assert.equal(row.targets[0].frameId, row.targets[1].frameId); movement(row, 1); row.passed = true })
    if (!frameBindingOnly) {
    await available('motion-rapid-retarget', async () => {
      const row = await observe('motion-rapid-retarget', script(['Continue', 'Page note', 'Edge action']))
      assert.equal(row.targets.length, 3)
      const next = movement(row, 2), prior = row.preTargetSamples.find((s: any) => s.incomingToken === row.targets[2].token)
      row.retarget = { next, priorRead: prior, status: 'not-proven' }
      assert.ok(prior && !prior.exceptionDetails && prior.hud?.token === row.targets[1].token)
      const current = prior.hud.pointer?.rect ?? prior.hud.history?.point
      assert.ok(current, 'A real previous BCR or the actual just-cleared displayed history is available')
      assert.ok(distance(next.from, current) < 1.5, 'The next origin matches the actually observed displayed position, including a zero-progress first frame')
      const previousAnimation = row.samples.findLast((s: any) => s.hud?.token === row.targets[1].token && s.hud.pointer?.animations?.some((a: any) => a.currentTime >= 0 && a.currentTime < a.duration))
      assert.ok(previousAnimation, 'If the rapid prior movement was never observed, keep this proof not-proven without sleeps or repeats')
      row.retarget = { ...row.retarget, previousAnimationSample: previousAnimation.sequence, status: 'actual-current-position-proven' }; row.passed = true
    })
    await available('motion-cross-operation-expired', async () => {
      const first = await observe('motion-cross-operation-prior', script(['Continue']), 80)
      const target = first.targets[0]; assert.ok(target)
      await pause(Math.max(0, target.originalSendCompletedAt + 1000 - Date.now()))
      const evidence: any = {}; const before = await c.inspectTarget(contents, target, evidence, false)
      assert.ok(before.hud && !before.hud.hostConnected && !before.hud.pointer && before.hud.history)
      assert.ok(Date.now() - target.originalSendCompletedAt > 900)
      first.passed = true
      const row = await observe('motion-cross-operation-expired', script(['Page note']))
      row.previousOperation = { caseIndex: receipt.cases.indexOf(first), caseLabel: first.label, targetIndex: 0,
        observedBeforeNext: evidence.target, cueAbsent: true, elapsedMs: row.startedAt - target.originalSendCompletedAt }
      assert.notEqual(row.actualReport.runOperation.id, first.actualReport.runOperation.id)
      assert.equal(row.targets[0].frameId, target.frameId); assert.equal(row.targets[0].issuedNavigationId, target.issuedNavigationId)
      const witness = movement(row, 0); assert.ok(distance(witness.from, before.hud.history.point) < 1); row.passed = true
    })
    await available('motion-hover-float', async () => {
      const row = await observe('motion-hover-float', script(['Continue']), 650)
      const samples = row.samples.filter((s: any) => s.hud?.phase === 'completed' && s.hud.arrow && s.hud.pointer && settled(s))
      assert.ok(samples.length >= 2)
      const first = samples[0].hud, ys = samples.map((s: any) => s.hud.arrow.rect.y)
      assert.ok(Math.max(...ys) - Math.min(...ys) > 0.3, 'Actual arrow has a small visible local float')
      assert.ok(Math.max(...ys) - Math.min(...ys) <= 3.1)
      assert.equal(samples.some((s: any) => distance(s.hud.point, first.point) > 0.01 || distance(s.hud.label.rect, first.label.rect) > 0.1), false)
      row.floatSamples = samples.map((s: any) => s.sequence); row.passed = true
    })
    await available('motion-named-key', async () => {
      const row = await observe('motion-named-key', script(['Continue'], 'pressKey', 'Enter'), 80)
      assert.equal(row.targets.length, 1); assert.equal(row.targets[0].keyLabel, 'Enter')
      assert.ok(row.samples.some((s: any) => s.hud?.label?.text.includes('Key Enter')))
      const events = await contents.executeJavaScript('fixtureEvents'); row.originalEvents = events
      assert.equal(events.filter((e: any) => e.type === 'keydown' && e.key === 'Enter').length, 1)
      row.passed = true
    })
    await available('motion-generic-key', async () => {
      const row = await observe('motion-generic-key', script(['Page note'], 'pressKey', 'Meta+Enter'), 80)
      assert.equal(row.targets.length, 1); assert.equal(row.targets[0].keyLabel, '⌨')
      assert.ok(row.samples.some((s: any) => s.hud?.label?.text.includes('Key ⌨')))
      assert.equal(row.samples.some((s: any) => s.hud?.label?.text.includes('Meta+Enter')), false)
      const events = await contents.executeJavaScript('fixtureEvents'), actual = events.filter((e: any) => e.type === 'keydown' && e.key === 'Meta+Enter')
      row.originalEvents = events; assert.equal(actual.length, 1)
      assert.deepEqual(actual[0].modifiers, { ctrl: false, alt: false, meta: false, shift: false })
      row.passed = true
    })
    await available('motion-short-single-click', async () => {
      manager.setBounds(c.id, { x: 16, y: 52, width: 720, height: 260 }); await c.nativePage(contents, 'motion-short-layout-baseline')
      const short = await c.action(contents, 'motion-short-single-click', 'click', 'Continue')
      assert.ok(short.passed !== false, 'Recheck the original short single-action late-scroll counterexample once')
    })
    await available('motion-same-process-single-hover', async () => {
      manager.setBounds(c.id, { x: 16, y: 52, width: 720, height: 660 }); await c.nativePage(contents, 'motion-frame-layout-baseline')
      const row = await observe('motion-same-process-single-hover', script(['First embedded action']), 80)
      assert.equal(row.targets.length, 1)
      const target = row.targets[0], step = row.actualActionSteps[0]
      assert.ok(row.actualMainFrameId); assert.equal(target.sessionId, undefined); assert.notEqual(target.frameId, row.actualMainFrameId)
      const early = row.samples.filter((s: any) => s.startedAt >= step.finishedAt && s.hud?.phase === 'completed' &&
        s.hud.hostConnected && s.hud.pointer && s.returnedAt < s.hud.expiresAt)
      assert.ok(early.length > 0, 'Observe the actual child cue after the real action and before its original expiry, not a late absent HUD')
      assert.ok(row.frames.some((f: any) => early.some((s: any) => s.sequence === f.sampleAtOrBefore.sampleSequence)), 'An original child-cue compositor frame accompanies its early real sample')
      const evidence: any = {}; await c.inspectTarget(contents, target, evidence, false)
      row.postActionTarget = evidence.target
      row.lateScrollWitness = { actualStepSequence: step.sequence, earlyCueSampleSequences: early.map((s: any) => s.sequence),
        originalExpiresAt: early[0].hud.expiresAt, lateObservedAt: evidence.target.observedAt,
        boundary: 'The post-action child document facts are read late; clear/replace plus retained history after expiry is not geometry invalidation.' }
      const events = evidence.target.actualDocumentFacts.events
      assert.ok(Array.isArray(events) && events.some((event: any) => event.type === 'scroll' && event.at >= step.finishedAt), 'The actual target child reports the queued post-action scroll')
    })
    await c.osWindow('motion-original-background-window')
    }
  }
  if (!frameBindingOnly) for (const method of ['js', 'cdp']) await available(`motion-${method}-executor`, async () => {
    const code = method === 'js' ? 'return await js("globalThis.performFixtureWork()")' : 'return await cdp("Runtime.evaluate",{expression:"4+4",returnByValue:true})'
    const row = await observe(`motion-${method}-executor`, code, 80)
    const samples = row.topSamples.filter((s: any) => s.hud?.executor)
    assert.ok(samples.length > 0)
    const completed = samples.filter((s: any) => s.hud.phase === 'completed')
    assert.ok(completed.length > 0); assert.equal(completed.some((s: any) => s.hud.executor.animationName !== 'none'), false)
    if (method === 'js') assert.ok(samples.some((s: any) => s.hud.phase === 'running' && (c.phase === 'second' ? s.hud.executor.animationName === 'none' : s.hud.executor.animationName !== 'none')))
    assert.equal(samples.some((s: any) => s.hud.point || s.hud.pointer), false)
    row.passed = true
  })
  const snapshot = await manager.create(c.id, c.url)
  receipt.retained = { browserId: snapshot.id, profileId: snapshot.profileId, url: contents.getURL(), profileClicks: await contents.executeJavaScript('localStorage.getItem("proofClicks")') }
  if (c.phase === 'first') await writeFile(c.retainedFile, JSON.stringify(receipt.retained))
  motion.caseIndices = receipt.cases.map((row: any, index: number) => ({ index, label: row.label }))
}
