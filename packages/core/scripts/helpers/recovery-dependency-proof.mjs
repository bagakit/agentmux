import { registerHooks, createRequire } from 'node:module'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../', import.meta.url)), seen = new Set()
function record(path) {
  const output = process.env.AGENTMUX_BACKUP_DEPENDENCY_LOADS
  if (!output || seen.has(path) || !path.startsWith(root) || path.includes('/.vite-temp/') || !existsSync(path) || !statSync(path).isFile()) return
  seen.add(path)
  appendFileSync(output, JSON.stringify({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }) + '\n', { mode: 0o600 })
}
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (url.startsWith('file:')) record(fileURLToPath(url))
  return result
} })
process.on('exit', () => { for (const [path, module] of Object.entries(createRequire(import.meta.url).cache)) if (module?.loaded) record(path) })
