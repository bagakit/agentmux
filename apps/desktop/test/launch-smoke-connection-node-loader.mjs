import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context)
  if (!url.startsWith('file:') || !process.env.LAUNCH_SMOKE_LOADED || loaded.format !== 'module') return loaded
  const path = relative(root, fileURLToPath(url))
  if (!/^(?:packages\/core|packages\/identity)\/dist\/.+\.js$/u.test(path) && !path.includes('/node_modules/@ctxmux/sdk/')) return loaded
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8')
  const row = { path, surface: 'evaluated-compiled-owner', originalSHA256: createHash('sha256').update(source).digest('hex') }
  return { ...loaded, source: "import { appendFileSync as __launchOwnerEvaluated } from 'node:fs'; __launchOwnerEvaluated(" + JSON.stringify(process.env.LAUNCH_SMOKE_LOADED) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + source }
} })
