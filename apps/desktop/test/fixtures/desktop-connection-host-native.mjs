// Reuse the original deterministic Runtime byte port. The child entry and all
// Host/Core business owners remain actual compiled product modules.
import '../../../host/test/fixtures/host-index-native.mjs'
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null || !url.endsWith('/agentmux-host.js')) return result
  const original = String(result.source), hash = createHash('sha256').update(original).digest('hex')
  const marker = { artifact: 'actual-compiled-node-index', pid: process.pid, sourceSHA256: hash,
    helperPath: process.env.AGENTMUX_WORKSPACE_MOVE_HELPER, connectorDirectory: process.env.AGENTMUX_CONNECTOR_DIRECTORY,
    moteConfigurationPath: process.env.AGENTMUX_MOTE_CONFIGURATION_PATH, hostConfigurationPath: process.env.AGENTMUX_HOST_CONFIGURATION_PATH }
  const trace = process.env.DESKTOP_CONNECTION_CHILD_LOADED
  if (!trace) return result
  const witness = "import { appendFileSync as __desktopChildLoaded } from 'node:fs'; __desktopChildLoaded(" + JSON.stringify(trace) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n'
  return { ...result, source: witness + original }
} })
