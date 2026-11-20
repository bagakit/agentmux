type Point = { x: number; y: number }
type Box = Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>

const clearance = 0.65
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const contains = (box: Box, point: Point) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom

function connectionPorts(box: Box, other: Box) {
  const insetX = Math.min(9, (box.right - box.left) / 2), insetY = Math.min(9, (box.bottom - box.top) / 2)
  const x = Math.max(box.left + insetX, Math.min(box.right - insetX, (other.left + other.right) / 2))
  const y = Math.max(box.top + insetY, Math.min(box.bottom - insetY, (other.top + other.bottom) / 2))
  return [
    { tip: { x: box.left, y }, gutter: { x: box.left - 1, y } },
    { tip: { x: box.right, y }, gutter: { x: box.right + 1, y } },
    { tip: { x, y: box.top }, gutter: { x, y: box.top - 1 } },
    { tip: { x, y: box.bottom }, gutter: { x, y: box.bottom + 1 } },
  ]
}

function crosses(a: Point, b: Point, box: Box) {
  return a.x === b.x
    ? a.x > box.left && a.x < box.right && Math.min(a.y, b.y) < box.bottom && Math.max(a.y, b.y) > box.top
    : a.y > box.top && a.y < box.bottom && Math.min(a.x, b.x) < box.right && Math.max(a.x, b.x) > box.left
}

function simplify(points: readonly Point[]): Point[] | null {
  const result: Point[] = []
  for (const point of points) {
    const previous = result.at(-1), before = result.at(-2)
    if (previous && distance(previous, point) === 0) continue
    if (before && previous && (before.x === previous.x && previous.x === point.x || before.y === previous.y && previous.y === point.y)) {
      if (distance(before, point) < distance(before, previous) + distance(previous, point)) return null
      result.pop()
    }
    result.push(point)
  }
  return result
}

function roundedPath(points: readonly Point[], origin: Box) {
  const xy = (point: Point) => `${point.x - origin.left} ${point.y - origin.top}`
  let path = `M ${xy(points[0]!)}`
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index]!, before = points[index - 1]!, after = points[index + 1]!
    const radius = Math.min(2, distance(before, point) / 2, distance(after, point) / 2)
    const toward = (target: Point) => ({ x: point.x + radius * Math.sign(target.x - point.x), y: point.y + radius * Math.sign(target.y - point.y) })
    path += ` L ${xy(toward(before))} Q ${xy(point)} ${xy(toward(after))}`
  }
  return `${path} L ${xy(points.at(-1)!)}`
}

function arrowFits(tip: Point, approach: Point, view: Box) {
  // Include the wings as well as the anchor when checking the scrollport clip.
  const dx = Math.sign(tip.x - approach.x), dy = Math.sign(tip.y - approach.y)
  const tail = { x: tip.x - 4.5 * dx, y: tip.y - 4.5 * dy }
  return contains(view, { x: tail.x - 2.5 * dy, y: tail.y - 2.5 * dx }) &&
    contains(view, { x: tail.x + 2.5 * dy, y: tail.y + 2.5 * dx })
}

/** Consider orthogonal routes through the endpoint gutters and the viewport margins. */
export function focusCardLinkPath(from: Box, to: Box, origin: Box, view: Box, obstacles: readonly Box[]): string | null {
  const starts = connectionPorts(from, to), ends = connectionPorts(to, from)
  const blockers = [from, to, ...obstacles.filter(box => box !== from && box !== to).map(box => ({
    left: box.left - clearance, top: box.top - clearance, right: box.right + clearance, bottom: box.bottom + clearance,
  }))]
  const xRails = new Set([from.left - 1, from.right + 1, to.left - 1, to.right + 1,
    (from.left + from.right + to.left + to.right) / 4, view.left + 1, view.right - 1])
  const yRails = new Set([from.top - 1, from.bottom + 1, to.top - 1, to.bottom + 1,
    (from.top + from.bottom + to.top + to.bottom) / 4, view.top + 1, view.bottom - 1])
  let best: Point[] | null = null, bestScore = Infinity
  for (const start of starts) for (const end of ends) {
    const a = start.gutter, b = end.gutter
    const consider = (turns: readonly Point[]) => {
      const points = simplify([start.tip, a, ...turns, b, end.tip])
      if (!points || points.some(point => !contains(view, point)) || !arrowFits(end.tip, points.at(-2)!, view)) return
      const length = points.slice(1).reduce((total, point, index) => total + distance(points[index]!, point), 0)
      const score = length + 8 * (points.length - 2)
      if (length < 8 || score >= bestScore || points.slice(1).some((point, index) => blockers.some(box => crosses(points[index]!, point, box)))) return
      best = points
      bestScore = score
    }
    consider([{ x: a.x, y: b.y }])
    consider([{ x: b.x, y: a.y }])
    for (const x of xRails) consider([{ x, y: a.y }, { x, y: b.y }])
    for (const y of yRails) consider([{ x: a.x, y }, { x: b.x, y }])
  }
  return best ? roundedPath(best, origin) : null
}
