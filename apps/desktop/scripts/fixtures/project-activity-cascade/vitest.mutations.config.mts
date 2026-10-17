import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Pin the copied artifact through its real public exports. A concurrent build
// of the shared checkout cannot replace this qualification's selected Core.
const core = new URL('../../../../../packages/core/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', core), 'utf8'))
const alias = Object.entries(manifest.exports).flatMap(([name, target]) => {
  const entry = target as { import?: string }
  return entry.import ? [{ find: '@agentmux/core' + (name === '.' ? '' : name.slice(1)), replacement: fileURLToPath(new URL(entry.import, core)) }] : []
}).sort((left, right) => right.find.length - left.find.length)
export default { resolve: { alias } }
