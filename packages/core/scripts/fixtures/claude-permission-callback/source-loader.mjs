import { stripTypeScriptTypes } from 'node:module'
import { existsSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve as pathResolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = pathResolve(import.meta.dirname, '../../../../..')
const mutation = process.env.AGENTMUX_CLAUDE_PERMISSION_MUTATION ?? ''
export function transformPermissionSource(path, original, selected = mutation) {
  const replacements = {
    'no-native-decision': ['packages/core/src/providers/claude.ts', "  permissionDecision: {\n    eventName: 'PermissionRequest',", "  disabledPermissionDecision: {\n    eventName: 'PermissionRequest',"],
    'forget-callback-invocation': ['packages/core/src/client.ts', 'const callbackToolCallId = nativeHookToolCallId(envelope.payload ?? {})', 'const callbackToolCallId = undefined'],
    'short-permission-timeout': ['packages/core/src/providers/claude.ts', "...(eventName === 'PermissionRequest' ? {} : hookCommandTimeout('claude'))", "...hookCommandTimeout('claude')"],
    'forget-confirmed-answer': ['packages/core/src/agent-interaction-state.ts', "request.permissionHook.response?.delivery === 'connection-written'", "request.permissionHook.response?.delivery === 'not-written'"],
    'promote-unconfirmed-answer': ['packages/core/src/agent-interaction-state.ts', "request.permissionHook.response?.delivery === 'connection-written'", 'true'],
    'forget-close-proof': ['packages/core/src/agent-interaction-state.ts', "request.permissionHook?.closed === 'decision-returned' && request.permissionHook.response?.delivery", 'request.permissionHook?.response?.delivery'],
    'hide-other-requests': ['packages/core/src/agent-interaction-state.ts', "return additional?.find(request => request.kind !== 'permission' || !request.permissionHook?.nativeTurnEnded)", 'return undefined']
  }
  const replacement = replacements[selected]
  if (replacement?.[0] !== path) return original
  if (original.split(replacement[1]).length !== 2) throw new Error('Exact production mutation anchor changed: ' + selected)
  return original.replace(replacement[1], replacement[2])
}
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(pathToFileURL(root + '/').href) && specifier.endsWith('.js')) {
    const source = specifier.replace(/\/dist\//u, '/src/').replace(/\.js$/u, '.ts')
    if (existsSync(new URL(source))) return { url: source, shortCircuit: true }
  }
  const match = specifier.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (match) {
    const directory = pathResolve(root, 'packages', match[1])
    const manifest = JSON.parse(await readFile(pathResolve(directory, 'package.json'), 'utf8'))
    const entry = manifest.exports?.[match[2] ? '.' + match[2] : '.']?.import
    if (entry?.startsWith('./dist/')) {
      const source = pathResolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      if (existsSync(source)) return { url: pathToFileURL(source).href, shortCircuit: true }
    }
  }
  if (context.parentURL?.startsWith(pathToFileURL(root + '/').href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const source = new URL(specifier.replace(/\/dist\//u, '/src/').replace(/\.js$/u, '.ts'), context.parentURL)
    if (existsSync(source)) return { url: source.href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (!url.startsWith(pathToFileURL(root + '/').href) || !url.endsWith('.ts')) return next(url, context)
  const path = relative(root, fileURLToPath(url)), original = await readFile(fileURLToPath(url), 'utf8')
  const source = transformPermissionSource(path, original)
  if (process.env.AGENTMUX_CLAUDE_PERMISSION_LOADED) appendFileSync(process.env.AGENTMUX_CLAUDE_PERMISSION_LOADED,
    JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'),
      sha256: createHash('sha256').update(source).digest('hex'), changed: source !== original, mutation }) + '\n')
  return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
}
