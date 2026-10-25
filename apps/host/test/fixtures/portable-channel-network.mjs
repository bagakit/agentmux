// Only the official Discord SDK's HTTP transport is redirected; no Core/Provider methods change.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const host = process.env.HOST_CHANNEL_PACKAGE_ROOT
const origin = process.env.HOST_CHANNEL_PLATFORM_ORIGIN
if (!host || !origin) throw Error('The original portable test namespace is required')
const connectors = join(host, 'node_modules/@agentmux/connectors/package.json')
const require = createRequire(existsSync(connectors) ? connectors : join(host, 'package.json'))
const { DefaultRestOptions } = await import(pathToFileURL(join(dirname(require.resolve('@discordjs/rest')), 'index.mjs')).href)
DefaultRestOptions.makeRequest = async (url, init) => {
  const original = new URL(url)
  if (original.origin !== 'https://discord.com') throw Error('Unexpected native Discord API origin')
  return await fetch(origin + original.pathname + original.search, init)
}
