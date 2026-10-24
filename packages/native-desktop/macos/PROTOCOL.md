# AgentMux macOS native protocol

The native layer belongs to the Desktop host. Its connection lifetime is unrelated to Core AgentSession, Run, Tab or Region identity. Its `instanceId` is one UUID generated at process startup. The upstream MIT notice is preserved in [LICENSE.orca](LICENSE.orca); [UPSTREAM.md](UPSTREAM.md) records the pinned source.

The host starts `agentmux-native-macos --agent <socket> --token-file <file> --parent-pid <pid>` inside `AgentMux Native.app`. Bare development launches use the same arguments, defaulting owner PID to `getppid()` only when `--parent-pid` is omitted. The socket is mode `0600`; its private parent directory is supplied by the host. The peer must have the exact expected PID from `LOCAL_PEERPID`, the current UID from `getpeereid`, and the original nonempty token. Bundle IDs, executable display strings and application names do not grant authority. No authenticated connection within 15 seconds, owner process exit, or the final authenticated connection closing ends this native process. Shutdown removes its exact original socket inode, then removes its empty parent directory.

Requests and responses are UTF-8 NDJSON:

```json
{"id":1,"method":"handshake","params":{},"token":"<original-token>"}
{"id":1,"ok":true,"instanceId":"<native-instance-uuid>","result":{"platform":"darwin","provider":"agentmux-native-macos","providerVersion":"1.0.0","protocolVersion":1,"instanceId":"<same-uuid>","supports":{}}}
```

Every response, including refusal, contains its request `id` and the current native `instanceId`. An original request `operationId` is echoed unchanged. Mutations require the original `operationId` and exact `expectedInstanceId`; a different process never executes the old operation. Reusing an operation ID is rejected with `duplicate_operation` (or `operation_conflict` for different input) and does not execute it again. Native operation retention contains fingerprints and outcome metadata, not screenshot or clipboard payloads. The host owns original operation inspection, unknown outcomes, and result retention; an unavailable receipt never authorizes replay.

Read methods are `handshake`, `listApps`, `listWindows`, `listDisplays`, `getAppState`, `clipboardRead` and `permissionStatus`. Mutation methods are `click`, `performSecondaryAction`, `setValue`, `typeText`, `pressKey`, `hotkey`, `pasteText`, `scroll`, `drag`, `clipboardWrite` and `captureScreenshot` (selection may activate a native surface).

## Accurate application and window targets

`listApps` returns `{apps:[{name,bundleId,pid,processStartedAt,...}]}`. `processStartedAt` is the original `NSRunningApplication.launchDate` as milliseconds since Unix epoch, with fractional milliseconds preserved. Unknown launch dates remain null and cannot authorize an action.

`listWindows` takes `{app:"pid:123",processStartedAt:1792932709123.456}` and returns `{app,windows:[{id,title,x,y,width,height,...}]}`. Names and window titles are presentation hints only. Discovery preserves distinct processes even when they share a Bundle ID.

`getAppState` requires `{app:"pid:123",processStartedAt:1792932709123.456,windowId:456,noScreenshot?:boolean,clientScope?:"<host-derived-context>"}`. It returns `{snapshotId,snapshot:{id,app:{name,bundleId,pid,processStartedAt},window:{id,...},coordinateSpace:"window",treeText,...},screenshot,screenshotStatus}`. Its exact OS process and window are checked again. `windowIndex`, app-name queries and `restoreWindow` are unsupported. AX windows are matched by native window number, or unambiguous exact OS geometry; labels and titles never establish identity.

Actions add the original `snapshotId` and their upstream action arguments to the same target. Native AX object equality validates element identity; snapshot labels do not authorize controls. `clientScope` namespaces AX snapshots for one host-derived client context and is not a Core AgentSession identity. Caller-supplied `session` and `worktree` do not create native business sessions.

A completed action followed by observation failure returns `ok:true` with `{action:{...original receipt,targetWindowId},observation:{state:"failed",error:{code,message}}}`. The native layer keeps the original window selector and never substitutes another window. An action failure returns `ok:false,error:{code,message}`. Permission preflight readings do not gate actual AX reads or screen capture; the actual operation supplies the result.

## Screens and capture

`listDisplays` returns `{displays:[{id,x,y,width,height,scale,isMain}]}` using the OS `CGDirectDisplayID`, global Quartz points and each display's actual backing scale.

`captureScreenshot` parameters are one of:

- `{mode:"selection",allowEditing?:boolean}`: native AppKit rectangle overlay. Escape returns explicit `cancelled`; no display is a failure. Only explicit `true` offers the optional “标注…” action (E); Enter still completes directly.
- `{mode:"display",displayId}`: exact active display from discovery.
- `{mode:"rect",rect:{x,y,width,height}}`: finite positive rectangle in global Quartz points.
- `{mode:"window",windowId,app:"pid:123",processStartedAt}`: window number and original live owner process must both match.

Quartz coordinates have origin `(0,0)` at the primary display's upper-left, x increasing right, y increasing down. Displays left of or above the primary display have negative coordinates. Selection covers the full display union, converts AppKit coordinates once, and restores the previously foreground application after selection/cancellation. Mixed-scale captures use the largest scale of the intersected displays. Non-display gaps remain transparent. AX action coordinates remain relative to the returned exact window (`coordinateSpace:"window"`).

Capture returns `{state:"captured",screenshot:{data:"<base64-PNG>",format:"png",width,height,scale},engine,selectionRect:{x,y,width,height}}`, `{state:"cancelled"}`, or `{state:"failed",error:{code,message}}`. Missing pixels never imply cancellation. macOS 14+ uses ScreenCaptureKit's SCScreenshotManager. macOS 12/13 uses the native CoreGraphics APIs available on those systems. The 14+ operation does not silently switch engines after a capture failure.

An original selection request with `allowEditing:true` adds exactly `completionAction:"capture"|"edit"` to a captured result. Both intents contain the same selected PNG; `edit` requests a host-owned editor and does not edit, copy, save or attach pixels inside Native. Omitted/false opt-in and all cancelled/failed results omit the field. The Node capture convenience validates the action against that original request; it never infers an intent from presentation or supplies one for a malformed receipt. Public pure capture consumers omit the opt-in and retain their original outcome contract.

## Clipboard and permissions

`clipboardRead` takes `{format:"text"|"png"}` and returns `{format,data:string|null,state:"read"|"empty",changeCount}`. PNG data is base64, validated as a readable single PNG; other native image representations are encoded as PNG. Text is UTF-8. `clipboardWrite` takes `{format,data}` and returns `{state:"written",format,changeCount,byteLength}` only after a real pasteboard write receipt. A failed write reports its actual stage. These calls never paste or type implicitly.

`permissionStatus` is read only: `{accessibility:"granted"|"not-granted",screenshots:"granted"|"not-granted",source:"macOS-preflight",authoritativeForOperation:false}`. An explicit person may launch `--permissions` or `--permission accessibility|screenshots` for the native permission surface. Remote automation cannot invoke those permission UI flows. A negative preflight readout does not establish why an operation failed.

## Build profiles and concurrent requests

Production validates the exact running peer with Security.framework. The connected socket's kernel `LOCAL_PEERTOKEN` is passed as `kSecGuestAttributeAudit` to `SecCodeCopyGuestWithAttributes`, binding lookup to its original process generation rather than a reusable PID. `SecCodeCheckValidity` must satisfy signed identifier `dev.agentmux.desktop` and the same persistent leaf certificate as the native layer itself, in addition to OS PID, UID and the token. A missing audit token or failed guest lookup rejects that connection in every build profile; it never falls back to a PID lookup. A caller-selected PID/token, process command line or unvalidated Bundle ID does not grant authority.

A release `AgentMux Native.app` always requires this validated Desktop signer. It contains no CLI or environment option that disables signing checks. Only a compiled `DEBUG` bare executable outside an `.app` may use the development/test profile after the OS reports it unsigned (`errSecCSUnsigned`) or ad-hoc with no certificates. Unknown Security.framework results are rejection, never an unsigned inference; a real signing certificate always selects the production check, including in DEBUG. Refusal affects the exact native connection and retains Main, Core, Agent Sessions and Runs.

The build entry uses explicit profiles: `--configuration debug --bare` returns the bare SwiftPM executable and performs no `.app` assembly. The application profile requires release configuration and is signed only by the Desktop packaging owner. Stdout contains one `agentmux.native-build.v1` JSON receipt with profile/configuration, original SwiftPM binary path and output identity; compiler logs go to stderr. Development launch chooses the bare debug executable explicitly and never falls back from a refused production connection.

One connection accepts concurrent requests. Responses may arrive out of order and remain correlated by original numeric id, instanceId and operationId. Socket writes serialize complete response frames. Reading is incremental in 64 KiB chunks, with the same 26 MiB single-frame limit as Node; truncated/invalid frames never dispatch operations. Socket EOF is observed while a person selects a screen rectangle.

AX snapshots and actions share their necessary state mutex. Selection uses one native surface with the normal AppKit event loop; another selector reports `capture_busy`. Clipboard, permissions, application discovery and display discovery remain callable during selection. Clipboard operations and temporary paste share only the pasteboard owner. A clipboard-based paste retains the requested text because posted CGEvents do not acknowledge when the target consumed it; it does not restore old content based on a guessed delay.

Per-image allocation/decoding uses the host bounds: 16,384 pixels per dimension, 32 Mi pixels and 18 MiB PNG bytes (24 MiB base64). Checks precede numeric conversion, pixel allocation and decompression. These limits protect one image and do not constrain cumulative captures or Agent state. A result outside the frame returns correlated `response_too_large`; it does not authorize replay.

## Action receipts and verification fields

`getAppState.noScreenshot` defaults to `true`; only explicit `false` attempts window pixels. Queries do not open permission UI. `snapshot.elements` exposes `{index,actions:string[],frame:{x,y,width,height}|null}`; frames are window relative and action names are the unmodified AX machine names. `performSecondaryAction.action` must equal an original name exactly. Readable labels in treeText do not grant or select actions.

The public Core snapshot query is AX only. Raw Node/native `getAppState` retains the explicit pixel option, but `noScreenshot:false` is classified as a capture mutation and requires its original `operationId` plus exact `expectedInstanceId`, exactly as `captureScreenshot` does. Missing/true remains an AX observation; a malformed value is refused rather than inferred.

`action` contains `path` (`accessibility`, `synthetic` or `clipboard`), `actionName` (native name or null), `fallbackReason` (string or null), `targetWindowId`, and optional `verification`:

- `{state:"verified",property,expected:string|null,actualPreview:string|null}` records a property/readback match.
- `{state:"unverified",reason,expected?:string|null,actualPreview?:string|null}` preserves an unconfirmed effect. Posted events remain unverified.
- `{state:"accepted",completedPages,requestedPages}` records AX success for every requested scroll, without claiming rendered content.
- `{state:"failed",reason:"action_unsupported",completedPages,requestedPages}` preserves already accepted pages before an unsupported reply.
- `{state:"unverified",reason:"native_action_outcome_unknown",completedPages,requestedPages,error:{code,message}}` preserves an unconfirmed later scroll.
- `{state:"unverified",reason:"clipboard_paste",clipboardRestoration:"retained_for_paste",clipboardChangeCount}` records a confirmed clipboard write and a posted, unconfirmed paste. If later key posting is refused/unconfirmed, reason is "clipboard_paste_post_unconfirmed" and error preserves the posting failure while retaining the write receipt. If the pasteboard did not confirm its write, reason is "clipboard_write_unconfirmed" with clipboardChangeCount and error, and no shortcut is posted.

Only an explicit AX unsupported/not-implemented reply permits another input path. An AX write accepted with unconfirmed readback returns unverified. A cannot-complete/error returns `action_outcome_unknown` and never automatically attempts a second write. Keyboard sequences recheck original process launch identity and exact window focus for every event, target the original PID and stop after recipient changes. Cleanup may release only already pressed keys in the original live process. Unknown input is never retried.

An action completed before observation failure retains its receipt and the exact observation error; another window is never substituted.

Scroll and drag also carry the original process/window snapshot through every posted event. They recheck original launch identity and the exact focused/hit-tested window. A changed recipient or allocation failure after any posted event reports `action_outcome_unknown`; it never replays the remaining sequence. A drag attempts mouse-up cleanup only in its original still-live process. Native `setValue` uses its actual AX reply rather than treating a failed settable probe as absence of the capability.

Clipboard raster formats supported by ImageIO (including TIFF) are read through image-source metadata before creating pixels. Their encoded source budget is the permitted 32 Mi pixel count times eight bytes for a 16-bit RGBA raster, independent of the final 18 MiB PNG wire bound. This retains ordinary uncompressed TIFF conversion without creating an unbounded `NSImage`/`CGImage` first. Metadata/decode failures and actual resource-limit failures have separate error codes.
