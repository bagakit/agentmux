import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const [cli, endpoint, mode] = process.argv.slice(1)
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
// Explicit user Toolkit invocation uses the local user port, never an inherited Agent claim.
delete env.AGENTMUX_AGENT_SESSION_ID
delete env.AGENTMUX_AGENT_CAPABILITY
async function query(action) {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--endpoint', endpoint, 'device', action], { env, timeout: 15000, maxBuffer: 1024 * 1024 })
  const response = JSON.parse(stdout)
  if (response.ok !== true) throw new Error(response.error?.message ?? 'Device query did not complete')
  return response.result
}
const facts = await query('ls')
const registered = facts.devices.filter(device => device.revokedAt === undefined)
const devices = registered.filter(device => device.online === true)
const unconfirmed = registered.some(device => device.online === undefined)
const result = { schema: 'agentmux.toolkit.result.v1', summary: unconfirmed ? `${devices.length} confirmed connected · other connections unconfirmed` : `${devices.length} connected`,
  items: devices.map(device => ({ label: device.name, value: device.connection?.address ? `Connected · ${device.connection.address}` : 'Connected' })), links: [],
  notice: (facts.mobileAccess.state === 'connected' ? 'Connect your phone and Mac to the same Wi-Fi, then open the link.' : `Phone connection unavailable: ${facts.mobileAccess.message}`)
    + (unconfirmed ? ' Some device connections are unconfirmed. Refresh to check their status.' : '') }
if (mode === 'link') {
  const link = await query('link')
  result.links.push({ label: 'Phone connection link', url: link.url })
}
console.log(JSON.stringify(result))
