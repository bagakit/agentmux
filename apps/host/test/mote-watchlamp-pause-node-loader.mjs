import './mote-presence-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { instrumentWatchlamp } from './mote-watchlamp-pause-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@agentmux/demand' || specifier.startsWith('@agentmux/demand/')) {
      const key = specifier === '@agentmux/demand' ? '.' : './' + specifier.slice('@agentmux/demand/'.length)
      const entry = JSON.parse(readFileSync(resolve(root,'packages/demand/package.json'),'utf8')).exports[key]?.import
      if (!entry?.startsWith('./dist/src/')) throw Error('Missing original Demand source export: ' + key)
      return next(pathToFileURL(resolve(root,'packages/demand/src',entry.slice(11).replace(/\.js$/u,'.ts'))).href, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) { const result = next(url, context); if (!url.startsWith('file:') || result.source == null) return result; const source = String(result.source), loaded = instrumentWatchlamp(source, relative(root, fileURLToPath(url)), 'node'); return source === loaded ? result : { ...result, source: loaded } }
})
