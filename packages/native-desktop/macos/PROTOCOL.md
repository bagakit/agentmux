# AgentMux macOS native protocol

The native layer belongs to the Desktop host. Its connection lifetime is unrelated to Core AgentSession, Run, Tab or Region identity. Its `instanceId` is one UUID generated at process startup. The upstream MIT notice is preserved in [LICENSE.orca](LICENSE.orca); [UPSTREAM.md](UPSTREAM.md) records the pinned source.

The host starts `agentmux-native-macos --agent <socket> --token-file <file> --parent-pid <pid>` inside `AgentMux Native.app`. Bare development launches use the same arguments, defaulting owner PID to `getppid()` only when `--parent-pid` is omitted. The socket is mode `0600`; its private parent directory is supplied by the host. The peer must have the exact expected PID from `LOCAL_PEERPID`, the current UID from `getpeereid`, and the original nonempty token. Bundle IDs, executable display strings and application names do not grant authority. No authenticated connection within 15 seconds, owner process exit, or the final authenticated connection closing ends this native process. Shutdown removes its exact original socket inode, then removes its empty parent directory.

Requests and responses are UTF-8 NDJSON:

```json
{"id":1,"method":"handshake","params":{},"token":"<original-token>"}
{"id":1,"ok":true,"instanceId":"<native-instance-uuid>","result":{"platform":"darwin","provider":"agentmux-native-macos","providerVersion":"1.0.0","protocolVersion":1,"instanceId":"<same-uuid>","supports":{}}}
```

Every response, including refusal, contains its request `id` and the current native `instanceId`. An original request `operationId` is echoed unchanged. Mutations require the original `operationId` and exact `expectedInstanceId`; a different process never executes the old operation. Reusing an operation ID is rejected with `duplicate_operation` (or `operation_conflict` for different input) and does not execute it again. Native operation retention contains fingerprints and outcome metadata, not screenshot or clipboard payloads. The host owns original operation inspection, unknown outcomes, and result retention; an unavailable receipt never authorizes replay.

Read methods are `handshake`, `listApps`, `listWindows`, `listDisplays`, `captureDisplays`, `getAppState`, `clipboardRead` and `permissionStatus`. Mutation methods are `click`, `performSecondaryAction`, `setValue`, `typeText`, `pressKey`, `hotkey`, `pasteText`, `scroll`, `drag`, `clipboardWrite` and `captureScreenshot`.

## Accurate application and window targets

`listApps` returns `{apps:[{name,bundleId,pid,processStartedAt,...}]}`. `processStartedAt` is the original `NSRunningApplication.launchDate` as milliseconds since Unix epoch, with fractional milliseconds preserved. Unknown launch dates remain null and cannot authorize an action.

`listWindows` takes `{app:"pid:123",processStartedAt:1792932709123.456}` and returns `{app,windows:[{id,title,x,y,width,height,...}]}`. Names and window titles are presentation hints only. Discovery preserves distinct processes even when they share a Bundle ID.

`getAppState` requires `{app:"pid:123",processStartedAt:1792932709123.456,windowId:456,noScreenshot?:boolean,clientScope?:"<host-derived-context>"}`. It returns `{snapshotId,snapshot:{id,app:{name,bundleId,pid,processStartedAt},window:{id,...},coordinateSpace:"window",treeText,...},screenshot,screenshotStatus}`. Its exact OS process and window are checked again. `windowIndex`, app-name queries and `restoreWindow` are unsupported. AX windows are matched by native window number, or unambiguous exact OS geometry; labels and titles never establish identity.

Actions add the original `snapshotId` and their upstream action arguments to the same target. Native AX object equality validates element identity; snapshot labels do not authorize controls. `clientScope` namespaces AX snapshots for one host-derived client context and is not a Core AgentSession identity. Caller-supplied `session` and `worktree` do not create native business sessions.

A completed action followed by observation failure returns `ok:true` with `{action:{...original receipt,targetWindowId},observation:{state:"failed",error:{code,message}}}`. The native layer keeps the original window selector and never substitutes another window. An action failure returns `ok:false,error:{code,message}`. Permission preflight readings do not gate actual AX reads or screen capture; the actual operation supplies the result.

## Screens and capture

`listDisplays` returns `{displays:[{id,x,y,width,height,scale,isMain}]}` using the OS `CGDirectDisplayID`, global Quartz points and each display's actual backing scale.

`captureScreenshot` captures one exact source. Its parameters are one of:

- `{mode:"display",displayId}`: exact active display from discovery.
- `{mode:"rect",rect:{x,y,width,height}}`: finite positive rectangle in global Quartz points.
- `{mode:"window",windowId,app:"pid:123",processStartedAt}`: window number and original live owner process must both match.

Quartz coordinates have origin `(0,0)` at the primary display's upper-left, x increasing right, y increasing down. Displays left of or above the primary display have negative coordinates. Mixed-scale captures use the largest scale of the intersected displays. Non-display gaps remain transparent. AX action coordinates remain relative to the returned exact window (`coordinateSpace:"window"`).

Capture returns `{state:"captured",screenshot:{data:"<base64-PNG>",format:"png",width,height,scale},engine,selectionRect:{x,y,width,height}}`, or `{state:"failed",error:{code,message}}`. Any other mode, including `selection`, fails `invalid_argument`: native draws no selection surface, and the AgentMux Desktop capture surface owns region selection and its cancellation over `captureDisplays` frames. macOS 14+ uses ScreenCaptureKit's SCScreenshotManager. macOS 12/13 uses the native CoreGraphics APIs available on those systems. The 14+ operation does not silently switch engines after a capture failure.

`captureDisplays` takes `{includeHostWindows?:boolean}` (default `false`; other types fail `invalid_argument`) and returns `{state:"captured",capturedAt,timing:{contentMs,windowListMs,responseSerializationMs,totalMs},displays:[{displayId,frame:{x,y,width,height},scale,safeTop,windows:[{windowId,frame:{x,y,width,height},owner?}],timing:{captureMs,pngMs,base64Ms,totalMs},png?,width?,height?,engine?,issue?}]}` for every active display. `capturedAt` is milliseconds since Unix epoch, taken before the first grab. `frame` is global Quartz points and `scale` the display's backing scale; `safeTop` is the points a camera housing covers at the display's top (`NSScreen.safeAreaInsets.top`, 0 without one). Each display is grabbed once without the cursor; a captured display carries base64 `png` with its pixel `width`/`height` and `engine`, and a display that cannot be captured carries only `issue` (`"<code>: <message>"`) plus its timing, leaving the others usable.

On macOS 14+, one `SCShareableContent` enumeration serves every display's grab and one shared pixel-exclusion list. Pixel filtering uses only `SCWindow.owningApplication.processID`: included excludes `getpid()` (the helper); excluded excludes `getpid()` plus the accurate host `--parent-pid`, including panels and every other capturable window owned by that PID. It does not use titles or normal-layer metadata and does not exclude other PIDs. The host can remain visible for both captures; no fade, hide or step-out is part of this protocol. `windows` comes from one window-server list beside the grabs, remains on-screen normal-layer (layer 0) only, intersects each display front to back, and applies the same owner filter as the pixels. Its `frame` is exact global Quartz bounds and may extend past the display; `owner` is presentation only. Fully transparent windows and windows excluded from sharing are not listed.

On macOS 12/13, CoreGraphics included capture works normally. For excluded capture, a display intersecting a visible host window reports `host_window_exclusion_unavailable` and no pixels, while displays without a visible host remain capturable. With no visible host, excluded capture proceeds normally. If the window-server list is unavailable, host visibility is unknown rather than absent: excluded fails `window_list_unavailable` before any display grab, while included remains available. CoreGraphics pixels that contain the host are never labeled excluded. This is a controlled-source branch contract, not a claim of real 12/13 device verification.

Native `timing.contentMs` measures the single content enumeration (0 on CoreGraphics), `windowListMs` the single window-server list, and `totalMs` the native capture operation before response serialization. Every display, including an issue display, has `captureMs`, `pngMs`, `base64Ms` and `totalMs`; successful and failed stages both record their actual elapsed time. `responseSerializationMs` measures the one actual full-response `JSONSerialization` encoding in `writeJSON`: the writer inserts a unique structural timing token, encodes once, then replaces only that token with the measured number before the existing frame-size check and transport write. It does not encode the full pixel payload twice, add a phased protocol or replay an operation; the tiny marker splice is not counted as JSON encoding.

The Node SDK adds `lazyConnectionMs` (lazy launch/authenticated connection, 0 when reused), `socketReadMs` (actual NDJSON buffering and UTF-8 decoding, including fragments), `jsonParseMs` (`JSON.parse` plus response-envelope decoding), `requestMs` (the whole request) and `validationMs` (result validation). Each stage is measured once and none is derived from `requestMs`. Native and final top-level timing, and every per-display timing, are closed shapes: exactly their documented keys, each a finite number in `[0,150000]`. Missing keys, unknown keys, strings, nested objects, paths, draft text or pixel payloads fail `invalid_display_frames`; native timing is rejected before it is spread or returned. Timing diagnostics contain no pixels, paths or draft text.

A display whose bounds changed since enumeration reports `display_configuration_changed`. All displays share one response frame: a display whose encoded pixels would not fit beside the displays before it reports `image_too_large`, so the response never becomes `response_too_large`. If no display yields pixels the request fails with `display_capture_unavailable`; no active display is `display_not_found`. Native keeps no frame, overlay or selection state after the response. One grab set runs at a time: a second request while a producer still owns the displays, including after an observer timeout, reports `capture_busy`. The handshake advertises `supports.observation.displayFrames`.

## Clipboard and permissions

`clipboardRead` takes `{format:"text"|"png"}` and returns `{format,data:string|null,state:"read"|"empty",changeCount}`. PNG data is base64, validated as a readable single PNG; other native image representations are encoded as PNG. Text is UTF-8. `clipboardWrite` takes `{format,data}` and returns `{state:"written",format,changeCount,byteLength}` only after a real pasteboard write receipt. A failed write reports its actual stage. These calls never paste or type implicitly.

`permissionStatus` is read only: `{accessibility:"granted"|"not-granted",screenshots:"granted"|"not-granted",source:"macOS-preflight",authoritativeForOperation:false}`. An explicit person may launch `--permissions` or `--permission accessibility|screenshots` for the native permission surface. Remote automation cannot invoke those permission UI flows. A negative preflight readout does not establish why an operation failed.

## Build profiles and concurrent requests

Production validates the exact running peer with Security.framework. The connected socket's kernel `LOCAL_PEERTOKEN` is passed as `kSecGuestAttributeAudit` to `SecCodeCopyGuestWithAttributes`, binding lookup to its original process generation rather than a reusable PID. `SecCodeCheckValidity` must satisfy signed identifier `dev.agentmux.desktop` and the same persistent leaf certificate as the native layer itself, in addition to OS PID, UID and the token. A missing audit token or failed guest lookup rejects that connection in every build profile; it never falls back to a PID lookup. A caller-selected PID/token, process command line or unvalidated Bundle ID does not grant authority.

A release `AgentMux Native.app` always requires this validated Desktop signer. It contains no CLI or environment option that disables signing checks. Only a compiled `DEBUG` bare executable outside an `.app` may use the development/test profile after the OS reports it unsigned (`errSecCSUnsigned`) or ad-hoc with no certificates. Unknown Security.framework results are rejection, never an unsigned inference; a real signing certificate always selects the production check, including in DEBUG. Refusal affects the exact native connection and retains Main, Core, Agent Sessions and Runs.

The build entry uses explicit profiles: `--configuration debug --bare` returns the bare SwiftPM executable and performs no `.app` assembly. The application profile requires release configuration and is signed only by the Desktop packaging owner. Stdout contains one `agentmux.native-build.v1` JSON receipt with profile/configuration, original SwiftPM binary path and output identity; compiler logs go to stderr. Development launch chooses the bare debug executable explicitly and never falls back from a refused production connection.

One connection accepts concurrent requests. Responses may arrive out of order and remain correlated by original numeric id, instanceId and operationId. Socket writes serialize complete response frames. Reading is incremental in 64 KiB chunks, with the same 26 MiB single-frame limit as Node; truncated/invalid frames never dispatch operations.

AX snapshots and actions share their necessary state mutex. `captureDisplays` and `captureScreenshot` take no AX lock; clipboard, permissions, application discovery and display discovery remain callable while display pixels are produced. Clipboard operations and temporary paste share only the pasteboard owner. A clipboard-based paste retains the requested text because posted CGEvents do not acknowledge when the target consumed it; it does not restore old content based on a guessed delay.

Per-image allocation/decoding uses the host bounds: 16,384 pixels per dimension, 32 Mi pixels and 18 MiB PNG bytes (24 MiB base64). Checks precede numeric conversion, pixel allocation and decompression. These limits protect one image; across displays only `captureDisplays` bounds the total, to keep its single response inside the frame. A result outside the frame returns correlated `response_too_large`; it does not authorize replay.

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
