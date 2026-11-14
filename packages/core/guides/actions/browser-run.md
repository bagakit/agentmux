# browser run

<!-- amux:content -->
Run a program in an open Browser

[browser targets](../actions/browser-targets.md "amux:include")

Usage:
  amux browser run --browser <browser-id> [--operation-id <operation-id>] < program.js
  echo 'return await snapshot()' | amux browser run --browser <browser-id>
  amux browser history [--browser <browser-id>]
  amux browser inspect --operation-id <operation-id>
  amux browser stop --operation-id <operation-id>
  amux browser replay --browser <browser-id> --operation-id <operation-id> [--preview | --step <n> | --run]

The program is read from stdin as a whole — there is no --code flag, because a real program
contains quotes, backslashes and newlines that every shell layer would re-escape.

It runs as an async function body in an isolated subprocess, so `await` and `return` both
work, and a runaway program cannot take AgentMux down with it. A program has 30 seconds. Waits
(`waitForElement`, `waitForLoad`, `waitForNetworkIdle`) and `js()` never outlast that: when the
program is almost out of time they throw "… because this program's time is almost up" while the
program still runs, so you can catch it, return what you have, and continue in a new program.
Prefer several short programs to one long one. `waitForElement(name, {exact: true, role})` waits
for one exact name (by default any name containing the text matches, so "Save" also matches "Save
draft"). `waitForUrl(url)` or `waitForUrl({contains})` waits for this page
to be at a URL and returns `{url, navigationId}`; take a fresh snapshot of that page. Page functions ([Current browser-capability-examples](../../dist/browser-page-capability.js "amux:generated browser-capability-examples"), …)
are injected into that subprocess. The current capability registry exposes:
[Current browser-capability-directory](../../dist/browser-page-capability.js "amux:generated browser-capability-directory")
Elements are addressed by the refs a snapshot hands you — never coordinates.
A page function that AgentMux itself refuses or cannot confirm throws an error with `error.kind`
(what failed, such as `locator-changed` or `page-dialog`) and `error.effects`. `effects:
"not-dispatched"` means nothing reached the page, so retrying is safe; `"unknown"` means the action
may have happened, so read the page before trying again. Errors without these fields came from the
page or your own code; decide from them only after looking.
`click(ref, {count: 2})` double-clicks and `click(ref, {button: "right"})` right-clicks (or
`"middle"`), as trusted input at the same checked point. Unknown options are refused before anything
is pressed.
`drag(sourceRef, destinationRef)` performs one native left-button drag between two snapshot refs.
HTML5 drag/drop uses Chromium’s original payload; pointer/mouse controls use native movement and release.
Both endpoints must still belong to the original page and be hittable. It accepts no selector or coordinates.
After a press, a changed page/target or lost acknowledgement is `effects: "unknown"`; inspect the original
page and operation before another action. A dispatched drop/release does not certify the website’s business result.

`tap(ref)` sends one native touch contact. `longPress(ref, {durationMs: 600})` holds
that contact (600 ms by default). `swipe(sourceRef, destinationRef)` moves between two
current refs, and `pinch(ref, {scale: 2})` changes the separation of two contacts inside
one ref (scale 2 by default). Both pinch contacts must fit and be hittable in that
original target. Scale describes contact separation; inspect the page to verify its result.
These functions accept no selectors or screen coordinates and do not change device identity
or `navigator.maxTouchPoints`. A hold must fit the original program's remaining time.
Stop, Take control or navigation fences the remaining contact movement/end; an interrupted
contact has `effects: "unknown"` and is never automatically replayed. Inspect the original
page before a fresh gesture. After control is explicitly returned,
`cdp("Input.dispatchTouchEvent", {type: "touchCancel", touchPoints: []})` can end
remaining contacts on that current page; it does not resume the interrupted gesture.

`pressKey(ref, key)` takes one key or a chord written with `+`, such as `Control+a`, `Shift+Tab` or
`Meta+z`; modifiers are held around the key and always released. On macOS use `Meta` for the system
shortcuts (select all, copy, undo). A shifted letter types its capital; for other shifted
characters pass the character itself, such as `"!"`.
`cdp(method, params)` reaches this page and its frames only. A command that reaches the whole
Profile or the browser (cookies, site storage, certificate checks, permissions, download behavior,
creating or closing targets) is refused before it is sent, with what to use instead. Raw `Input.*`
counts as this program's own input, like `click()`.
When the page opens an alert, confirm, prompt or leave-page dialog, the page call in flight fails at
once with a message that names the dialog, instead of waiting out the budget. Calls that need the
page are refused unsent until it is answered: `dismissDialog()` closes it, `acceptDialog()` says OK
(`acceptDialog(text)` only for a prompt); navigation does not get past an open dialog. `pageInfo()` still
answers while one is open. Agreeing to leave a page
that asks to stay open is the person's decision. A dialog still open when the program ends is
dismissed, and the outcome is indeterminate, so look at the page first.
`snapshot(options)` and `snapshotText(options)` accept `scope: "page"|"viewport"`,
`within` (a unique CSS region in the main document), `withinRef` (an issued ref's actual document),
`interactiveOnly`, and `maxNodes` (default 200, maximum 1000). Use either within or withinRef.
Observation counts distinguish the full captured graph, scoped/matched nodes and returned nodes.
Omitted documents are excluded by scope; missingFrames are failed reads. A small response does
not mean fewer AX trees were captured. Each call replaces the prior snapshot, including snapshotText;
use its newest refs. Superseded refs in the same run are refused rather than retargeted.

A ref outlives the run that issued it: refs from an earlier `browser run`, even from before
AgentMux restarted, are matched back onto the page by what they pointed at (role, name, and
which one of the same-named). That match is by appearance, not identity — it can land on a
different element that looks the same — so a run that used one is reported `indeterminate`
with the details, not `completed`.

Requires Agent browser automation to be enabled in Settings › Browser. It is off by default,
and the refusal says so rather than failing quietly.

Every receipt also includes an `operation` object with one stable operation id, the operator identity,
ordered semantic steps, and a replay reference. Keep that id when refining a program: it is the join key
for the Browser activity timeline, the desktop operation journal, and later replay. Raw passwords, cookies,
page text, coordinates, and opaque JavaScript/CDP arguments are never stored in replay facts; sensitive
steps remain explicit review gates.

That id only arrives with the final receipt, which is too late to ask about a program still
running. Pass `--operation-id <id>` to choose it yourself, and it is addressable from the moment
the program starts: `amux browser inspect --operation-id <id>` says how it is going, and
`amux browser stop --operation-id <id>` stops it. Neither needs the same connection, the same
process, or the Browser id — the operation, not the request, is what those two address, so a
disconnect does not take the operation with it. Asking about an id AgentMux has no record of is
a successful answer of nothing, not a failure; stopping one that has already finished answers
with its existing outcome.

During an embedded Agent program, confirmed native input isolation keeps ordinary human click,
hover, wheel, key/IME, paste and drop out of the webpage; these gestures never take control.
Host navigation and execution Viewport changes require explicit Take control. Reading activity,
editing an address draft and messaging the operator remain available. Isolation preparation or
failure is reported separately; unconfirmed isolation is never a claim that input is blocked.
Program completion and Stop end execution while retaining Agent control and input isolation.
Only explicit Take control hands the embedded page to the person and fences future actions
on the original operation; Chromium actions already dispatched may still complete. Inspect the
original receipt and page rather than replaying unknown effects. A subsequent `browser run`
returns BROWSER_HUMAN_CONTROL_ACTIVE after human takeover until the person explicitly chooses Return to Agent.
Return restores Agent control and isolation only; it never resumes or replays the old program. There is no public
CLI return/approval flag: an Agent cannot impersonate that human handoff.

Large JSON return values become a durable `browser-result-artifact` reference (8 MiB per value,
64 MiB retained store). Small values up to 128 KiB, including undefined/null, return inline.
Keep the original reference; its Workspace, Browser, operation and source must stay intact.
Use `return await readResult(reference, {offset: 0, maxBytes: 65536})` in this Browser to read
base64 bytes, totalBytes and nextOffset. Join decoded bytes then parse JSON. A navigation or
restart does not require rerunning the original actions. Each read stays bounded; missing or
evicted results are explicit. A Browser without a verified Workspace still runs small scripts;
durable result capture is unavailable. If capture fails, actions may already have happened:
inspect the page and do not automatically rerun the script.

For binary files, use `return await download(ref, {path: "report.bin", timeoutMs: 30000})`.
The native listener is registered before the current ref is clicked. Only a completed transfer
published into this Browser's verified Workspace returns a `browser-download-file` reference;
cancelled/failed receipts have no file reference. Retain the original reference and use
`return await readDownload(reference, {offset: 0, maxBytes: 65536})` to read base64 bytes,
revision, totalBytes and nextOffset without triggering the download again. Navigation and
ordinary application restart preserve completed references. Read cost also reports the complete
bounded file scan used to verify its revision. Unknown Workspace binding is explicit; a failed
transfer never fabricates a Workspace file or blocks later healthy Browser programs.

Use `return await uploadFiles(ref, ["attachments/report.bin"])` on an actual file input from
this run's latest `snapshot()`. Upload refs are never recovered from an earlier run's ledger;
expired refs and a changed document require a fresh snapshot. The verified Workspace supplies
1–4 bounded files (16 MiB each); their exact bytes are pinned before assignment and the actual
FileList is verified. The receipt contains relative paths, names, byte counts and revisions.
Selected-file snapshots remain available after script completion until that Browser navigates
or closes. If assignment or acknowledgement is uncertain, inspect the original input and do
not automatically repeat it. When a click makes the page open a file chooser (a styled upload
button, or an input inside a frame), no system picker appears during the program; `pageInfo()`
returns `fileChooser: {handle, mode}` and `uploadFiles(handle, paths)` fills it the same verified
way. A newer chooser replaces the handle, and navigation voids it.

The receipt carries `result` (whatever the program returned), `logs` (everything it printed,
including on failure), and `outcome`, which is one of four:
  completed      the program finished
  script-failed  the program threw — fix the program
  stopped        AgentMux stopped it; the program itself is fine. Either its scale was the
                 problem (too slow, too much output), or a person took the page back mid-run.
                 Actions before that point did happen; nothing after did. The message names
                 the call it was in and how many had completed. Run it again once the page is free.
  indeterminate  what actually happened is unknown, for a reason the message names:
                 the process died partway (an action may already have been applied once), or a
                 ref from an earlier run was matched back by appearance and may have landed on a
                 look-alike, or the actions ran but their result could not be retained, or the
                 time ran out while a click, input or navigation was still in flight.
                 Look at the page before retrying — do not blind-retry.


### Page PNG and visible-region export

Use the page screenshot owner instead of raw CDP or an App-window screenshot:

```sh
amux browser capture --browser BROWSER_ID --operation-id CAPTURE_ID --within '#report' --pixel-ratio 2 --output report.png
```

This command runs one fixed `browser.run` program and writes its PNG to a **new caller-local file**. It never overwrites, uploads, selects a Browser, changes zoom/device emulation, scrolls or transfers control. Its result retains the original operation/report, Browser/navigation identity, `source`, actual image dimensions, byte count and local output hash. PNG bytes are omitted from CLI stdout after export; the original program result remains available through `browser inspect`/history. A failed output does not recapture. Keep the original operation after an unknown response.

Inside a program, the same API is:

```js
await waitForLoad(); // Native document load only; wait for this app's content separately.
return await captureScreenshot({within: '#report', pixelRatio: 2});
```

`captureScreenshot()` with no options captures the current viewport at its native density. The optional object accepts `within`, `clip` and `pixelRatio` only. `within` is one unique CSS selector in the main document. Alternatively, `clip:{x:12,y:20,width:640,height:360}` uses current viewport CSS pixels; `within` and `clip` are mutually exclusive. The whole requested region must already fit in the viewport; missing, ambiguous, hidden or outside regions fail explicitly. Current-frame refs, frame selectors and full-page/scrolling capture are unsupported. Use a scoped `snapshot({within:'#report'})` for observation; do not mistake a snapshot ref for a screenshot selector.

`pixelRatio` is output pixels per CSS pixel, greater than zero and at most 4, within the PNG pixel budget. It changes exported sampling, not the original viewport/zoom or responsive layout. `source.region` records the requested CSS rectangle and density; `image.width/height` are the actual encoded pixels. A null viewport/viewportWarning is an observation gap, not a successful density guarantee. The first native document is awaited; capture does not certify asynchronous charts, images, fonts, network-idle or business success. Wait for the page's actual readiness with the available page APIs before capturing.

Large PNG results follow the existing retained-result contract above. CLI export reads that original reference in bounded `readResult` continuations and never captures again; its metadata keeps `resultArtifact` alongside the decoded image metadata. The original Browser must have its verified Workspace for durable results. A missing/evicted result, human takeover or failed read preserves the original capture/report and fails export explicitly. PNGs whose JSON representation exceeds the existing 8 MiB result budget are unsupported; choose a smaller requested region or density explicitly.

Desktop page screenshots exclude AgentMux-owned control glow, operation cursor and debug decoration during capture while preserving the exact original control and input isolation. The page's own borders, highlights and content remain. Check `source.hostOverlays`: `excluded` confirms this host's presentation exclusion, while `unconfirmed` on another host is not a clean-capture guarantee. Visible and background pages use the same page owner; capture does not navigate to a different page or require OS screen-recording permission. Raw `cdp('Page.captureScreenshot',...)` captures the engine as requested and is not the clean API. `app capture` instead observes the App's Renderer/native composition and intentionally retains its UI.

To observe HTTP requests from the current main document, arm a reader before the action:

```js
const reader = await watchRequests({maxEntries: 100});
try {
  const page = await snapshot();
  await click(page.nodes.find(node => node.name === "Load items").ref);
  const response = await waitForResponse(reader, {url: {contains: "/api/items"}, status: 200}, {timeoutMs: 5000});
  return {response, traffic: await readRequests(reader, {afterSequence: 0, maxEntries: 20})};
} finally {
  await stopWatchingRequests(reader);
}
```

An exact string matches the whole observed URL; `{contains: "..."}` matches a URL part.
`method` is an uppercase HTTP method. A buffered response remains eligible, so a fast response
can arrive before the wait call. `watchRequests` acknowledges native observation before returning.
A reader belongs to this program and original main document. Navigation, Stop, a native disconnect
or program completion ends it; a later program cannot reuse its handle. Stopping one reader leaves
sibling readers and the Browser usable. Do not repeat an action because its response was not observed.

Readers keep 100 metadata events by default, or a requested 1–1000. `readRequests` returns sequence
numbers, `dropped` event-retention count, `evictedRequests` correlation-retention count and `unattributed` response count.
Reads return at most 64 KiB of metadata; use `nextAfterSequence` when `hasMore` is true.
`scannedEntries` reports the bounded retained entries examined, including entries before your cursor. A request evicted before its
response cannot be attributed later. URLs are capped at 8192 characters, methods at 64 and MIME types
at 256; a truncated observation is marked and cannot satisfy an exact URL/method wait. URL credentials,
headers and request/response bodies are omitted. Child documents, worker requests and WebSocket
messages are outside this main-document HTTP scope. Observation readers do not install request rules.


Install explicit request rules before the action, and withdraw the same program's rules afterward:

```js
const configured = await routeRequests([
  {match: {url: {contains: "/api/items"}, method: "GET"}, action: "mock",
   status: 200, headers: {"Content-Type": "application/json"}, body: '{"items":[]}'},
  {match: {url: {contains: "/telemetry"}}, action: "abort"}
]);
try {
  const page = await snapshot();
  await click(page.nodes.find(node => node.name === "Load items").ref);
} finally {
  // active means configured; hits distinguish matched requests and native-acknowledged outcomes.
  console.log(await unrouteRequests());
}
```

Rules use the same exact URL or `{contains: "..."}` and uppercase method matching as observation.
The first match wins; `continue` preserves the original request. Mock bodies are static UTF-8 text.
Response headers cannot set Profile cookies or override transport framing. The JSON definition is
bounded to 1 MiB. Only HTTP(S) requests from the original main frame are mocked or aborted;
unmatched requests and requests from other frames continue. Workers, WebSocket messages and
child documents are outside this rule scope. The activation receipt confirms configuration,
not a request hit. Withdrawal returns `hits`: matched, fulfilled, aborted, continued and
unconfirmed request counts, without retaining request bodies or private headers.

`setNetworkConditions({offline: true})` or
`setNetworkConditions({latencyMs: 150, downloadBytesPerSecond: 65536, uploadBytesPerSecond: -1})`
sets main-document HTTP(S) offline simulation and native HTTP(S) latency/throughput rules
in an independent CDP session on this original page.
`-1` is unlimited throughput; explicit limits are positive bytes per second. `clearNetworkConditions()` withdraws this same set.
Offline uses native request failure, takes precedence over mock rules, and reports
`offlineScope: "main-document-http"`. Latency and throughput use native URL rules.
These rules affect native transport; they do not override `navigator.onLine`, Profile proxy
settings or another CDP client's rules. Child/worker coverage is not confirmed. An engine
without the required native command reports application as unconfirmed and retains the
Browser; inspect the exact result and withdraw before changing configuration.

Rule and condition sets belong to this program and document. Navigation, Stop, disconnect or
program completion ends that exact native session through the original cleanup owner.
Cleanup observation is bounded; an unconfirmed detach keeps a warning and its original scope
for late completion, while Stop releases operation ownership. Other page consumers remain
attached. Do not configure and
withdraw concurrently. A failed native acknowledgement means `unknown`, not an automatic
retry or permission to repeat the page action. Explicit withdrawal can be retried on the same
configuration; replacing a set requires confirming that its predecessor was withdrawn.

These four network-configuration functions require a host that offers an isolated native network session.
Embedded Desktop and standalone CDP targets provide it. A shared extension target does not currently
advertise these configuration functions; its ordinary actions and request readers remain available.
