const assert = require('node:assert/strict')

// Runs inside the live renderer. Measure the SVG shape, independently of its path construction or routing helpers.
function measureEdges() {
  const canvas = document.querySelector('.goal-plan__canvas')
  const cards = new Map([...canvas.querySelectorAll('[data-goal-plan-node]')].map(card => [card.dataset.goalPlanNode, card.getBoundingClientRect()]))
  const visible = getComputedStyle(canvas.querySelector('.goal-plan__edges')).display !== 'none'
  const rect = side => canvas.querySelector(`[data-goal-plan-boundary="${side}"]`).getBoundingClientRect()
  const edges = [], boundaryEdges = []
  if (visible) for (const path of canvas.querySelectorAll('.goal-plan__edge')) {
    const { goalEdgeFrom: from, goalEdgeTo: to, goalBoundaryEdge: boundary } = path.dataset
    const source = boundary === 'start' ? rect('start') : cards.get(from)
    const target = boundary === 'finish' ? rect('finish') : cards.get(to)
    const length = path.getTotalLength(), transform = path.getScreenCTM()
    const point = distance => {
      const p = path.getPointAtLength(distance)
      return new DOMPoint(p.x, p.y).matrixTransform(transform)
    }
    const start = point(0), end = point(length)
    const error = Math.max(Math.abs(start.x - source.right), Math.abs(end.x - target.left),
      source.top + 3 - start.y, start.y - source.bottom + 3, target.top + 3 - end.y, end.y - target.bottom + 3)
    const obstructions = new Set()
    const otherCards = [...cards].filter(([id, box]) => id !== from && id !== to && box.left < target.left && box.right > source.right)
    for (let distance = 0; otherCards.length && distance < length; distance += 3) {
      const p = point(distance)
      for (const [id, box] of otherCards) if (p.x > box.left + 1 && p.x < box.right - 1 && p.y > box.top + 1 && p.y < box.bottom - 1) obstructions.add(id)
    }
    const edge = { from, to, boundary, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y },
      error, obstructions: [...obstructions] }
    if (boundary) boundaryEdges.push(edge)
    else edges.push(edge)
  }
  return { visible, scrollTop: canvas.scrollTop, scrollLeft: canvas.scrollLeft, edges, boundaryEdges }
}
const readGoalEdgeGeometry = evaluate => evaluate(`(${measureEdges.toString()})()`)

function assertGoalEdgeGeometry(facts) {
  assert.ok(facts.visible && facts.edges.length > 0, 'Expected visible original task dependencies')
  const physicalEdges = [...facts.edges, ...facts.boundaryEdges]
  const ports = new Map()
  for (const edge of physicalEdges) {
    const name = `${edge.from || 'Start'} → ${edge.to || 'Finish'}`
    assert.ok(edge.error < 1, `${name} attaches inside both original card sides (error ${edge.error}px)`)
    assert.deepEqual(edge.obstructions, [], `${name} clears every intervening task`)
    for (const [key, y] of [[JSON.stringify(['from', edge.from]), edge.start.y], [JSON.stringify(['to', edge.to]), edge.end.y]]) {
      const points = ports.get(key) ?? []
      assert.ok(points.every(other => Math.abs(other - y) > 2), `${name} needs a distinct visible port on ${key}`)
      points.push(y)
      ports.set(key, points)
    }
  }
}
module.exports = { readGoalEdgeGeometry, assertGoalEdgeGeometry }
