export function isDeepStrictEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return left === right
  if (typeof left !== 'object') return left === right
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (left instanceof RegExp && right instanceof RegExp) return String(left) === String(right)
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!rightKeys.includes(key) || !isDeepStrictEqual(left[key], right[key])) return false
  }
  return true
}
