# Browser SDK and MCP

This adapter connects to an existing AgentMux Browser owner. It starts no Browser,
Runtime or Agent, and chooses no active or first page. Node.js 24 or later is required.
Core's Browser SDK has no dependency on MCP, Electron or a Browser engine.

## Typed SDK

```ts
import { agentMuxRpcEndpoint } from '@agentmux/core'
import { connectBrowserSdk } from '@agentmux/core/browser-sdk'

const sdk = await connectBrowserSdk({
  endpoint: agentMuxRpcEndpoint('unix:/absolute/service.sock')
})
try {
  const availability = await sdk.discover()
  const { targets } = await sdk.call('browser.targets', {})
  // Select an exact target from your own task context; a title is not its identity.
  const result = await sdk.call('browser.run', {
    browserId: exactBrowserId,
    operationId: retainedOperationId,
    code: 'return await pageInfo()'
  })
} finally {
  await sdk.dispose()
}
```

`call` uses Core's original method, parameter and receipt types. `follow` delegates to
Core's `browser.follow` subscription with the original initial result, Gap and events;
its `dispose()` ends only that reader. Stop an operation explicitly with
`call('browser.stop', {operationId})`. Closing the SDK connection or losing a reply does
not confirm that a page action stopped or failed. Retain its original operation ID,
inspect it through the original owner, and do not automatically repeat the action.

The method catalog comes from Core's actual Control and native RPC registrations.
`discover()` distinguishes an advertised method set from unknown availability. When
availability is unknown, let the original service answer; do not treat it as an empty
confirmed catalog. An owner can accurately return `HOST_CAPABILITY_UNAVAILABLE` for a
method it does not implement. The standalone Browser currently advertises its page and
operation methods; task assets remain at the Desktop owner. Do not create a replacement
host or recording to make an unsupported task method appear available.

## MCP stdio

```sh
agentmux-browser-mcp --endpoint unix:/absolute/service.sock
```

A host configuration can instead invoke Node with this package's `dist/stdio.js` and
the same explicit `--endpoint` argument. `--help` reads setup without connecting.
The official [MCP TypeScript server SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server)
owns framing, initialization, negotiation, tool validation and cancellation. This package
uses its stdio factory and supports the SDK's negotiated protocol eras; it does not
implement a second MCP protocol.

The three tools are:

- `browser_discover`: exact targets plus the endpoint's advertised or unknown method availability.
- `browser_call`: an original Browser RPC method and its original business parameters.
- `browser_follow`: an explicit operation ID and optional original sequence, returning a bounded
  observation window with the unmodified initial Gap and ordered events. Window expiry,
  reader cancellation or stream closure does not mean that the operation completed.

All requests use the configured endpoint. Tools cannot supply a replacement endpoint,
caller credentials or human approval. A managed Agent's original
`AGENTMUX_AGENT_SESSION_ID` and `AGENTMUX_AGENT_CAPABILITY` must travel together through
the same Core helper the CLI uses; neither is accepted as a tool argument. Transport
credentials use Core's existing endpoint configuration. Do not put credentials into
command arguments or tool descriptions. A partial managed claim refuses this route
with `MANAGED_AGENT_CONTEXT_REQUIRED`; readable help and the original Agent remain.

Core's typed errors, unknown confirmation details and original receipts are preserved in
MCP structured results. MCP cancellation releases the original request/reader only;
use the exact operation's stop method for page work. No business state or cursor is
persisted by this adapter.
