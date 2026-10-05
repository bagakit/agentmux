import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultAgentMuxControlSocketPath } from '@agentmux/core'
import { parseToolkitToolDefinition, type ToolkitToolDefinition, type ToolkitScript } from '@agentmux/core/control'
import type { AppConfig } from '../shared/contracts.js'
import { resolveMobileConnectionPreferences } from '../shared/toolkit-preferences.js'
import type { PerformanceLaunch } from './toolkit-asset.js'

type Manifest = { id: string; name: string; icon: string; entry: string; args: string[];
  display?: { entry: string; args: string[] };
  actions: { id: string; label: string; entry: string; args: string[] }[] }
const assets = new Map<string, { manifest: Manifest; sources: Map<string, string> }>()
/** Immutable packaged bytes are read once, not again on every output fragment. */
function bundledAssets(root: string) {
  const cached = assets.get(root)
  if (cached) return cached
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Manifest
  const sources = new Map<string, string>()
  for (const entry of [manifest.entry, ...(manifest.display ? [manifest.display.entry] : []), ...manifest.actions.map(action => action.entry)]) {
    if (!/^[a-z0-9-]+\.mjs$/u.test(entry)) throw new Error('Bundled Toolkit entry must be a local script file.')
    sources.set(entry, readFileSync(join(root, entry), 'utf8'))
  }
  const value = { manifest, sources }; assets.set(root, value); return value
}
/** Bundled tools are file-backed extensions; scripts use the same execution owner as user tools. */
export function bundledToolkitTools(launch: PerformanceLaunch, config: AppConfig): ToolkitToolDefinition[] {
  const root = join(dirname(launch.script), 'mobile-connection')
  const { manifest, sources } = bundledAssets(root)
  const prefix = [launch.cli, `unix:${defaultAgentMuxControlSocketPath()}`]
  const preferences = resolveMobileConnectionPreferences(config)
  const fields = { id: manifest.id, name: manifest.name, icon: manifest.icon, ...preferences,
    workspacePath: launch.cwd, script: sources.get(manifest.entry)!, args: [...prefix, ...manifest.args],
    ...(manifest.display ? { display: { script: sources.get(manifest.display.entry)!, args: [...prefix, ...manifest.display.args] } } : {}),
    actions: manifest.actions.map(action => ({ id: action.id, label: action.label, script: sources.get(action.entry)!, args: [...prefix, ...action.args] })) }
  return [parseToolkitToolDefinition({ ...fields, revision: createHash('sha256').update(JSON.stringify(fields)).digest('hex') })]
}

export function bundledToolkitScript(launch: PerformanceLaunch, id: string): ToolkitScript | null {
  const root = join(dirname(launch.script), 'mobile-connection')
  const { manifest, sources } = bundledAssets(root)
  if (manifest.id !== id) return null
  const text = sources.get(manifest.entry)!
  return { toolId: id, path: join(root, manifest.entry), text, sha256: createHash('sha256').update(text).digest('hex') }
}
