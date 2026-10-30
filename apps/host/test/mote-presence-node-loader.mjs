import './mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { instrumentPresence } from './mote-presence-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@agentmux/client-ui/components/')) return next(pathToFileURL(resolve(root,'packages/client-ui/src/components',specifier.slice('@agentmux/client-ui/components/'.length)+'.tsx')).href,context)
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const file = resolve(dirname(fileURLToPath(context.parentURL)), specifier)
    if (file.endsWith('.js') && !existsSync(file) && existsSync(file.slice(0,-3)+'.tsx')) return next(pathToFileURL(file.slice(0,-3)+'.tsx').href,context)
  }
  return next(specifier,context)
}, load(url, context, next) {
  if (url.endsWith('.tsx')) return {format:'module',source:transformSync(readFileSync(fileURLToPath(url),'utf8'),{loader:'tsx',jsx:'automatic',format:'esm',target:'esnext'}).code,shortCircuit:true}

  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const source = String(result.source)
  let loaded = instrumentPresence(source, relative(root, fileURLToPath(url)), 'node')
  if (process.env.MOTE_PRESENCE_DROP_ACK === '1' && url.endsWith('/apps/host/src/ordinary-files.ts')) loaded += `
const __presenceWrite = OrdinaryWorkspaceFiles.prototype.write;
OrdinaryWorkspaceFiles.prototype.write = async function(...args) {
  const result = await __presenceWrite.apply(this,args);
  if (args[1].content.includes('intervalMs: 120000') && result.status === 'written') throw new Error('Private fixture dropped the original File ACK after real publication');
  return result;
};
`
  return loaded === source ? result : { ...result, source: loaded }
} })
