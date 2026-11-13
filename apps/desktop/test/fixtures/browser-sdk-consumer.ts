import { connectBrowserSdk } from '@agentmux/core/browser-sdk'
import { browserTaskImportInput } from '@agentmux/core/control'
const [socket, browserId] = process.argv.slice(2)
const sdk = await connectBrowserSdk({ endpoint: { transport: 'unix', path: socket! } })
try {
  const discovery = await sdk.discover()
  const input = browserTaskImportInput(browserId!, { format: 'agentmux.browser-task', version: 1, source: { assetId: 'external-origin', revision: 3 },
    definition: { name: 'External SDK task', url: 'https://sdk.invalid/', steps: [{ id: 'external-step', kind: 'navigate', url: 'https://sdk.invalid/', reviewed: false }], parameters: [] } })
  const created = await sdk.call('browser.task.import', { browserId: browserId!, input })
  const draft = await sdk.call('browser.task.draft', { browserId: browserId!, assetId: input.assetId })
  process.stdout.write(JSON.stringify({ pid: process.pid, discovery, created, draft, input }))
} finally { await sdk.dispose() }
