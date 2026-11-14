// Invoke the actual distributed Core CLI with the private gateway configuration.
process.argv = [process.execPath, new URL('../../../../packages/core/dist/headless-runtime-cli.js', import.meta.url).pathname,
  'serve', '--gateway-config', process.env.OUTBOUND_RELAY_GATEWAY_TEST_CONFIG]
await import('../../../../packages/core/dist/headless-runtime-cli.js')
