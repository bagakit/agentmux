import { readFileSync } from 'node:fs'
const path = process.argv[2]
let revision = -1
process.stdout.write(Array.from({ length: 180 }, (_, index) => `original-history-${String(index).padStart(3, '0')}\n`).join(''))
setInterval(() => {
  let next
  try { next = JSON.parse(readFileSync(path, 'utf8')) } catch { return }
  if (next.revision === revision) return
  revision = next.revision
  process.stdout.write(next.text)
}, 15)
