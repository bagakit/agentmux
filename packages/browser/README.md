# @agentmux/browser

The Browser host owns native pages, refs, programs, operation receipts and evidence. Desktop and the standalone CDP host use this same kernel. Core provides the public protocol without depending on this package, Electron or an engine installer.

Build the workspace package and run its Node entry with explicit paths:

```sh
pnpm --filter @agentmux/browser build
node packages/browser/dist/bin.js \
  --directory /absolute/browser-state \
  --executable /absolute/path/to/chromium \
  --socket /absolute/browser-state/control.sock
```

The executable must already exist. Nothing is downloaded. The local Unix service exposes its actual methods through `system.endpoint --inspect`; no Desktop window, Region, Workspace grant or Agent Run is fabricated.

```sh
AGENTMUX_RPC_ENDPOINT=unix:/absolute/browser-state/control.sock \
  amux browser create --url https://example.test/ --operation-id original-create
AGENTMUX_RPC_ENDPOINT=unix:/absolute/browser-state/control.sock \
  amux browser targets
```

Use the returned Browser id with the existing run, history, inspect, follow and stop methods. `browser close --browser ID --navigation NAV --operation-id ID` closes only an original target owned by this host. A page's beforeunload request is kept for the person; a program cannot approve it through raw CDP. Ordinary alert, confirm and prompt answers use the same native dialog owner in both hosts.

Stopping a program leaves the page and its input available. Stopping the Node service disconnects its transport and leaves the engine alive. Restarting with the same directory reconnects the original engine endpoint and target ids without replaying programs. If an engine started before its endpoint was retained, discovery reobserves only that original directory's native endpoint file. A target id that was never confirmed remains unavailable; URLs and titles do not claim it.

Keep each lifecycle operation id. A lost acknowledgement or an unconfirmed durable receipt is unknown, even when a current native close fact is visible. Inspect the original operation instead of repeating it. Damaged registry bytes are retained for repair. File upload and download capabilities require an actual Workspace owner; the standalone host does not advertise them or accept raw host-file assignment.

Library hosts can compose `StandaloneBrowserHost` or `serveStandaloneBrowser`. Importing either starts no engine. Platform-specific input, file access, visible feedback and native connections remain host ports; the shared kernel does not create an Agent Runtime.

The shared page dispatcher owns issued refs and sends commands through the original host transport. Page wait policies use that transport and the host's current navigation observation. Program owners retain their native control obligations and share cleanup warning and history receipt rules. A cleanup warning describes the resource or history write left unconfirmed, separately from the original program result. [Page dispatch](src/browser-page-dispatch.ts) · [Program completion](src/browser-program-completion.ts)

Network-idle waits track CDP requests by request and session identity. Redirect hops share one active request until its final completion or failure. [Page waits](src/browser-page-waits.ts)
