import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import { BrowserCdpSession } from '../../../src/main/browser-cdp-session.js'
import { discoverBrowserFrameDocuments } from '../../../src/main/browser-frame-documents.js'
import { BROWSER_OPERATION_FEEDBACK_WORLD_NAME } from '../../../src/main/browser-operation-feedback.js'

/** Read the actual closed shadow in its owning document; never synthesize a cue. */
export const targetStateExpression = `(()=>{const s=globalThis.__agentMuxBrowserOperationFeedback;
 const read=selector=>{const element=s?.shadow?.querySelector(selector);if(!element)return null;const r=element.getBoundingClientRect(),c=getComputedStyle(element);
 return{text:element.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},display:c.display,pointerEvents:c.pointerEvents,
 animations:element.getAnimations().map(animation=>({startTime:animation.startTime,currentTime:animation.currentTime,playState:animation.playState,
 duration:animation.effect?.getTiming().duration,keyframes:animation.effect?.getKeyframes().map(keyframe=>({transform:keyframe.transform,offset:keyframe.computedOffset}))}))}};
 const image=s?.shadow?.querySelector('.amux-browser-agent-avatar img');
 return{operationId:s?.operationId,navigationId:s?.navigationId,phase:s?.phase,kind:s?.kind,connected:!!s?.host?.isConnected,
 point:s?.point,pointer:read('.pointer'),label:read('.label'),image:image?{src:image.src,complete:image.complete,width:image.naturalWidth,height:image.naturalHeight}:null,
 clicks:Number(document.querySelector('[data-presence-click-count]')?.textContent??0),
 ripples:[...document.querySelectorAll('[data-agentmux-browser-click-feedback]')].map(element=>element.getAttribute('data-operation-id')),
 viewport:{width:innerWidth,height:innerHeight},reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches}})()`

export async function inspectOriginalDocument(contents: WebContents, node: { frameId?: string; backendNodeId?: number; sessionId?: string }) {
  const session = BrowserCdpSession.attach(contents)
  try {
    // Auto-attach is a real asynchronous protocol exchange, not a title/URL guess.
    await session.sendCommand('Page.getFrameTree')
    if (node.sessionId) {
      const end = Date.now() + 2000
      while (!session.frames.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
    }
    const discovered = await discoverBrowserFrameDocuments(session.sendCommand, session.frames)
    const document = discovered.documents.find(document => document.frameId === node.frameId)
    assert.ok(document, 'The original target frame must be rediscovered through its actual CDP ancestry')
    assert.equal(Boolean(document.sessionId), Boolean(node.sessionId), 'The actual target keeps its in-process or separate-session sender')
    const world = await document.sendCommand('Page.createIsolatedWorld', { frameId: document.frameId, worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME }) as { executionContextId: number }
    const response = await document.sendCommand('Runtime.evaluate', { contextId: world.executionContextId, expression: targetStateExpression, returnByValue: true }) as any
    assert.equal(response.exceptionDetails, undefined)
    return { document: { frameId: document.frameId, loaderId: document.loaderId, sessionId: document.sessionId, depth: document.depth },
      state: response.result.value, discovered: discovered.documents.length, missingFrames: discovered.missingFrames }
  } finally { session.detach() }
}

/** A private read at the real transport ACK boundary; it forwards the original result unchanged. */
export function observeClickAcknowledgement(contents: WebContents) {
  const original = contents.debugger.sendCommand
  const send = original.bind(contents.debugger)
  const worlds = new Map<number, { frameId: string; sessionId: string | undefined }>()
  const objects = new Map<string, { backendNodeId: number; contextId: number | undefined; sessionId: string | undefined }>()
  let target: { backendNodeId: number; contextId: number; sessionId: string | undefined } | undefined
  const evidence: any[] = []
  contents.debugger.sendCommand = (async (method: string, params: any = {}, sessionId?: string) => {
    const action = method === 'Runtime.callFunctionOn' && params.functionDeclaration === 'function () { this.click() }'
    if (action) {
      const object = objects.get(params.objectId)
      assert.ok(object && target && object.backendNodeId === target.backendNodeId && sessionId === target.sessionId,
        'The actual action object must match the source-resolved feedback target and sender')
      const read = async () => {
        const result = await send('Runtime.evaluate', { contextId: target!.contextId, expression: targetStateExpression, returnByValue: true }, sessionId) as any
        assert.equal(result.exceptionDetails, undefined); return result.result.value
      }
      const beforeDispatch = await read()
      assert.equal(beforeDispatch.ripples.length, 0, 'A click plan is not a confirmed click ripple')
      const result = await send(method, params, sessionId) as any
      const beforeDelivery = await read()
      assert.equal(beforeDelivery.ripples.length, 0, 'The ripple must wait until Main receives the original successful ACK')
      evidence.push({ backendNodeId: target!.backendNodeId, sessionId, beforeDispatch, beforeDelivery, exception: result.exceptionDetails ?? null })
      return result
    }
    const result = await send(method, params, sessionId) as any
    if (method === 'Page.createIsolatedWorld' && params.worldName === BROWSER_OPERATION_FEEDBACK_WORLD_NAME)
      worlds.set(result.executionContextId, { frameId: params.frameId, sessionId })
    if (method === 'DOM.resolveNode' && result.object?.objectId)
      objects.set(result.object.objectId, { backendNodeId: params.backendNodeId, contextId: params.executionContextId, sessionId })
    if (method === 'Runtime.callFunctionOn' && params.arguments?.[0]?.value?.kind === 'target' && params.arguments[0].value.phase === 'running') {
      const object = objects.get(params.objectId)
      assert.ok(object?.contextId && worlds.has(object.contextId), 'Feedback consumed an actual frame-specific isolated target handle')
      target = { backendNodeId: object.backendNodeId, contextId: object.contextId, sessionId }
    }
    return result
  }) as typeof original
  return { evidence, restore: () => { contents.debugger.sendCommand = original } }
}
