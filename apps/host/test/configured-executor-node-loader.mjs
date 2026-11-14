import './mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { instrument } from './configured-executor-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@agentmux/client-ui/components/')) {
    const component = resolve(root, 'packages/client-ui/src/components', specifier.slice('@agentmux/client-ui/components/'.length) + '.tsx')
    if (existsSync(component)) return { url: pathToFileURL(component).href, shortCircuit: true }
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const original = resolve(dirname(fileURLToPath(context.parentURL)), specifier), jsx = original.slice(0, -3) + '.tsx'
    if (!existsSync(original) && !existsSync(original.slice(0, -3) + '.ts') && existsSync(jsx)) return { url: pathToFileURL(jsx).href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX }
  }).outputText }
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const source = String(result.source), changed = instrument(source, relative(root, fileURLToPath(url)), 'node-loader')
  return changed === source ? result : { ...result, source: changed }
} })
