---
summary: "Durable local pages, isolated or injected display, and retained page interactions"
roles: "Agents publishing local page artifacts and authorized people managing their pages"
when: "Preserve, inspect, open, update or diagnose a generated local page across restarts"
---

# capsule

<!-- amux:content -->
The Capsule owner holds each original page, its saved content or external path, creation
defaults, stable endpoint and retained operations. A Capsule ID identifies content; a
Browser, Tab or Region identifies its display. Names, paths, ports, producer source fields
and amux links do not authenticate a caller or grant input permission.

The Capsule runtime is a fixed independent process carried by an ordinary ctxmux Run.
Core owns its durable running/stopped intent, exact Run binding and keepalive; the runtime
owns content and HTTP. Bare headless Core provides this same capability. Closing the App
or stopping Core only disconnects management; a healthy service continues serving.
Existing absolute content/state paths stay with their original execution Host, including
namespaces inside an App data directory. Independence never means opening an empty library.

Use amux capsule runtime inspect to read revision, desired intent, original Run, actual
runtime identity and any recovery issue. Inspection and page/configuration/interaction reads,
including original-operation queries, do not start or stop a service, replace an ended Run,
or save a binding. Prepared work remains starting/stopping; unknown dispatch stays unknown.
Existing keepalive owns convergence separately. To explicitly
start, use runtime start --input FILE with {operationId,expectedRevision}; to stop, use
runtime stop --input FILE with {operationId,expectedRevision,expectedRun:{runId}|null}.
Use exactly the revision and Run from inspection. Stop persists before the native effect;
ordinary page reads and keepalive cannot undo it. A timeout leaves the original operation
and Run unconfirmed: inspect them, do not resubmit Start/Stop or mint a replacement ID.
Native process readiness, runtime handshake, page HTTP and Browser display are distinct.

Only an explicit first capsule create or runtime start establishes running intent. Other
page, configuration and interaction operations, including original-operation queries, on
an unconfigured namespace return CAPSULE_RUNTIME_UNCONFIGURED with an explicit Start
recovery; they create no binding or service Run. Runtime stop may persist stopped intent
even before a first Start. Existing saved running intent still permits original-Run
recovery and keepalive.

On a remote Core, paths and 127.0.0.1 refer to that execution Host. The existing authorized
Core transport can manage the service; it does not create a tunnel or authorize a public
listener. Without a confirmed presentation route the page remains saved and serving on
its Host while remote Browser display is unavailable. A Toolkit TUI custom kit may wrap
these same management commands. Its own tool execution/Run remains separate; closing or
stopping that tool does not stop the Capsule service.

Use this module for static HTML, assets, existing frontend build output and explicitly
selected SPA routing. It does not run a build command, backend or temporary development
server. Managed storage copies content into the Host's durable library. Path storage
follows an exact external directory; missing source content is reported and never replaced
with an empty page. Storage mode and isolated/injected display mode are independent.

Read the matching leaf help for the exact JSON input:
- amux capsule ls and capsule inspect discover original IDs and current observations.
- amux capsule config inspect reads the actual new-page defaults and content location.
- amux capsule create --input FILE saves a page; sourcePath must be an absolute directory.
  A minimal JSON input is {"operationId":"ORIGINAL_OPERATION","sourcePath":"/absolute/build"}.
  Optional storageMode is managed or path; mode is isolated or injected. Keep the returned
  capsuleId and operationId. Saving content does not confirm that a Browser displayed it.
- amux capsule update and config update require the original expectedRevision. Creation
  defaults and a changed new-content root do not move or reinterpret existing pages.
- amux capsule open --input FILE requests display of {capsuleId,operationId,placement?}.
  Read amux capsule open --help for the existing placement JSON and original result reads.
  Before opening, read amux space --skill and browser --skill. With an attached Region,
  normally pass an explicit readable split in the same Tab instead of relying on the
  Desktop's new-Tab default when placement is omitted; preserve the user's new-Tab/tool
  choice and real layout exceptions. Reuse the confirmed Browser. Presentation, navigation
  and keyboard input focus are separate facts; retain the original page and input. Available rendering returns
  exact Browser/Tab/Region IDs, not a created/reused assertion. An unavailable presentation
  can leave the original HTTP page available. Open never confirms Agent delivery.
- amux capsule operation inspect --input FILE reads {operationId} without replaying it.

To embed a saved page in an AgentMux Desktop conversation reply, write
![Page title](amux://capsule/ORIGINAL_ID) in its own Markdown paragraph. Use the actual
returned capsuleId. Several such references may share a paragraph; ordinary bare links
and [labels](amux://capsule/ORIGINAL_ID) remain compact object links. Code stays literal.
The Desktop reconnects an existing native page while its card is visible, retaining that
document even if later service observation fails. A first display reads the original Capsule
and displays an already-serving page in its original isolated/injected native container. Reading a reply never Starts a
stopped/unconfigured service. Hide releases presentation resources through the original
Browser owner; it does not delete the page or auto-Close a used document. Expand and
Open in Browser provide larger reading surfaces. Injected page questions still require the
person's explicit confirmation in trusted App chrome. Shared read-only/document readers and
clients without this adapter keep the title/address. External native chat cards use their own
formatters and do not execute this page syntax; include an ordinary Capsule object link when
sharing there. A declaration confirms neither display nor permission.

Isolated pages have no App theme or communication channel. Injected pages receive only
the capabilities actually granted by their Host. Theme inheritance does not authorize
messaging; neither mode exposes Electron, Node or arbitrary RPC. A page SDK can prepare a
page-business question and save its draft. Only the trusted App input owner can confirm
the actual person's explicit submission to the original Agent target. An Agent, page
script, source field or HTTP request cannot self-author Human or answer a Provider-native
permission/question through this module.

In the App's injected Browser, window.capsule exposes capabilities(), theme(), request(),
read(), saveDraft(), inspectOperation(), createOperationId() and onThemeChanged(). Before
each mutation, retain an ID from createOperationId() and pass it explicitly to
request(question, draft, operationId) or
saveDraft(interactionId, expectedRevision, draft, operationId). Use undefined for an absent
initial draft. Persist the ID first when recovery must survive a page reload. Missing IDs
are rejected before dispatch; the preload never creates an implicit replacement ID.
After an unknown result, query inspectOperation(originalId). Error properties and text
are not a transport for original identity across ContextBridge.
The SDK derives its page and target from the exact
native document; do not supply a principal or recipient. It has no reply/approval method.
The person reviews the original question and answer in the App's Questions control and
explicitly confirms there. Host/Core's capsule.input is a narrow adapter protocol; it has
no ordinary CLI authoring command and requires that live native confirmation for prepare
and submit. A local transport identity or a saved prepared envelope alone grants none.

Keep page/request/answer identities and the original operation after an unknown response.
Read that same operation and its actual delivery receipt before deciding a next action;
do not automatically resend an answer, open another Browser or bind a newer Run. Saved
answers, submitted input and the Agent's adoption or task completion are separate facts.
Service, theme, diagnostic or input failures retain the page, draft, original workface and
healthy Agent. Capsule removal and content deletion are explicit, distinct effects;
external path content is never deleted by Capsule.
