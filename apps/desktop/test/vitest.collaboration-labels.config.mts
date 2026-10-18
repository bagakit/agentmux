import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from './vitest.collaboration-canvas.config.mts'

const graph = 'components/AgentCollaborationGraph.tsx', tooltip = 'components/WorkbenchNameTooltip.tsx'
const disclosure = 'reads the complete original relation in the window tooltip and releases it when the retained map hides'
const tracking = 'tracks a transformed original SVG path through real FloatingUI without following its live packet'
export const collaborationLabelMutations = [
  { file: tooltip, name: 'svg-camera-tracking', before: 'animationFrame: svgAnchor', after: 'animationFrame: false', assertion: tracking },
  { file: graph, name: 'stable-path-anchor', before: "event.currentTarget.querySelector<SVGPathElement>('.react-flow__edge-path')", after: 'event.currentTarget', assertion: tracking },
  { file: graph, name: 'hidden-map-disclosure', before: "useWorkbenchNameTooltip(record.label, '', !active,", after: "useWorkbenchNameTooltip(record.label, '', false,", assertion: disclosure },
  { file: graph, name: 'persistent-selected-caption', before: '</g>{tooltip.content}</>', after: '{record.selected ? <EdgeLabelRenderer><div className="collaboration-edge__label">{record.label}</div></EdgeLabelRenderer> : null}</g>{tooltip.content}</>', assertion: disclosure },
  { file: graph, name: 'focused-pointer-departure', before: 'if (!event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) tooltip.hide()', after: 'tooltip.hide()', assertion: disclosure },
  { file: graph, name: 'fixed-region-activity-slot', before: '<i className="collaboration-area__activity"', after: '{data.activity ? <i className="collaboration-area__activity"', tail: ' : undefined} />', tailAfter: ' : undefined} /> : null}', assertion: 'reserves the same region activity slot and geometry before during and after an original pulse' },
  { file: tooltip, name: 'html-frame-cost', before: 'animationFrame: svgAnchor', after: 'animationFrame: true', assertion: 'keeps the actual HTML lane disclosure event driven without a per-frame anchor read' },
  { file: tooltip, name: 'svg-observation-turn', before: 'if (svgAnchor) {', after: 'if (false) {', assertion: 'starts original SVG tooltip observation outside its mounting turn and cancels both pending and active work' },
  { file: tooltip, name: 'svg-observation-cancellation', before: 'if (startFrame !== undefined) window.cancelAnimationFrame(startFrame); ', after: '', assertion: 'starts original SVG tooltip observation outside its mounting turn and cancels both pending and active work' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_LABEL_MUTATION
const mutation = collaborationLabelMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown collaboration label mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let loaded = false
export default defineConfig({ ...shared, cacheDir: '.cache/collaboration-labels', plugins: [...shared.plugins ?? [], {
  name: 'collaboration-label-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    const applied = mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file
    let code = source
    if (applied) {
      if (code.split(mutation.before).length !== 2) throw Error('Unique relation label mutation anchor required')
      code = code.replace(mutation.before, mutation.after)
      if ('tail' in mutation) {
        if (code.split(mutation.tail).length !== 2) throw Error('Unique activity slot mutation closure required')
        code = code.replace(mutation.tail, mutation.tailAfter)
      }
      loaded = true
    }
    if (process.env.AGENTMUX_COLLABORATION_LABEL_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_LABEL_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutant: applied ? selected : null }) + '\n')
    if (source !== code) return { code, map: null }
  }, buildEnd() { if (selected && !loaded) throw Error('The actual relation label mutation source must be loaded') }
}], test: { ...shared.test, include: ['apps/desktop/test/collaboration-canvas-product.test.tsx', 'apps/desktop/test/collaboration-map-geometry.test.ts', 'apps/desktop/test/focus-lane-density.test.tsx'], passWithNoTests: false } })
