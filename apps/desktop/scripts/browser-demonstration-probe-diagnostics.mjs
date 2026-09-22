import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// One opt-in inspector observation of the actual compiled producer. No alternate CDP owner,
// source mutation, replacement sender, invented target or automatic action is involved.
export async function observeRecordedTarget(ctx) {
  const main = ctx.probe.main, file = join(ctx.desktopRoot, 'out/main/index.js')
  const lines = (await readFile(file, 'utf8')).split('\n')
  const probes = [
    ['context', 'if (contextId === void 0 || !this.live(generation))', '({contextId,current:this.live(generation),contextCount:this.contexts.size})'],
    ['event-object', 'if (result.exceptionDetails || !objectId)', '({hasObjectId:!!objectId,type:result.result?.type,className:result.result?.className,exception:!!result.exceptionDetails})'],
    ['actual-node', 'if (!actual?.role?.value || !actual.name?.value?.trim())', '({backendNodeId,current:input.isCurrent(),partial:partial.nodes?.slice(0,12).map(n=>({backendNodeId:n.backendDOMNodeId,ignored:n.ignored,role:n.role?.value,name:n.name?.value}))})'],
    ['full-node', 'if (!node || !node.ref || !node.name)', '({backendNodeId,current:input.isCurrent(),nodeCount:full.nodes.length,exact:full.nodes.filter(n=>n.backendNodeId===backendNodeId).map(n=>({backendNodeId:n.backendNodeId,ref:n.ref,sessionId:n.sessionId,role:n.role,name:n.name}))})'],
    ['uniqueness', 'if (matches.length !== 1 || matches[0]?.backendNodeId !== backendNodeId)', '({backendNodeId,current:input.isCurrent(),matches:matches.map(n=>({backendNodeId:n.backendNodeId,ref:n.ref,role:n.role,name:n.name}))})']
  ]
  const breakpointIds = new Map(), observations = []
  ctx.receipt.demonstration.targetDiagnostics = observations
  try {
    for (const [stage, anchor, expression] of probes) {
      const found = lines.flatMap((line, index) => line.includes(anchor) ? [index] : [])
      assert.equal(found.length, 1, `Actual producer diagnostic anchor must be unique: ${stage}`)
      const point = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(file).href, lineNumber: found[0] })
      breakpointIds.set(point.breakpointId, { stage, expression })
    }
  } catch (error) {
    for (const breakpointId of breakpointIds.keys()) await main.call('Debugger.removeBreakpoint', { breakpointId })
    throw error
  }
  let stopped = false
  const started = Date.now()
  const watching = (async () => {
    while (!stopped && Date.now() - started < 10_000) {
      const pause = main.pauses.shift()
      if (!pause) { await new Promise(done => setTimeout(done, 15)); continue }
      const probe = pause.hitBreakpoints?.map(id => breakpointIds.get(id)).find(Boolean)
      try {
        if (probe) {
          const result = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: pause.callFrames[0].callFrameId, expression: probe.expression, returnByValue: true })
          observations.push({ stage: probe.stage, value: result.result.value, exception: result.exceptionDetails?.text })
        } else observations.push({ stage: 'unexpected-pause', reason: pause.reason })
      } finally { await main.call('Debugger.resume') }
    }
  })()
  return { async stop() {
    stopped = true
    await watching
    for (const breakpointId of breakpointIds.keys()) await main.call('Debugger.removeBreakpoint', { breakpointId })
  } }
}
