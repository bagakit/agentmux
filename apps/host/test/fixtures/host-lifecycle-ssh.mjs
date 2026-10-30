#!/usr/bin/env node
import { existsSync, appendFileSync } from 'node:fs'
const destination = process.argv[process.argv.indexOf('--') + 1]
if (destination === 'route-b' && !existsSync(process.env.HOST_LIFECYCLE_ROUTE_READY)) {
  appendFileSync(process.env.HOST_CONFIG_SSH_TRACE, JSON.stringify({ phase: 'refused-private-route', destination, pid: process.pid }) + '\n')
  process.exit(255)
}
await import('./host-configuration-ssh.mjs')
