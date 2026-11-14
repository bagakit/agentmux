import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hashPublisherToken, parseRelayGatewayConfiguration, startRelayGateway } from './gateway.js'

const usage = 'agentmux-relay serve --config FILE\nagentmux-relay secret\n\nserve reads its private configuration once and owns only its Relay listener.\nsecret prints a new publisher credential and its SHA-256 hash; store the credential privately.\n'

export async function runRelayGatewayCli(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args.length === 1 && args[0] === '--help') { process.stdout.write(usage); return }
  if (args.length === 1 && args[0] === 'secret') {
    const token = randomBytes(32).toString('base64url')
    process.stdout.write(JSON.stringify({ token, tokenHash: hashPublisherToken(token) }) + '\n')
    return
  }
  if (args.length !== 3 || args[0] !== 'serve' || args[1] !== '--config' || !args[2]) throw new Error('Expected serve --config FILE or secret.')
  const text = await readFile(args[2], 'utf8')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Relay gateway configuration is not valid JSON.') }
  const configuration = parseRelayGatewayConfiguration(value)
  const gateway = await startRelayGateway(configuration)
  process.stdout.write(JSON.stringify({ operation: 'serve', service: 'agentmux-relay', protocol: 2, host: gateway.host, port: gateway.port }) + '\n')
  await new Promise<void>((resolve, reject) => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void gateway.stop().then(resolve, reject).finally(() => {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
      })
    }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
  })
}
