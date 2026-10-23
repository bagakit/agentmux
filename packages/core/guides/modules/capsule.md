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
  Before opening, read amux space --skill and browser --skill; preserve the original page,
  input and focus and reuse the confirmed Browser. An unavailable presentation can leave
  the original HTTP page available. Open never confirms Agent delivery.
- amux capsule operation inspect --input FILE reads {operationId} without replaying it.

Isolated pages have no App theme or communication channel. Injected pages receive only
the capabilities actually granted by their Host. Theme inheritance does not authorize
messaging; neither mode exposes Electron, Node or arbitrary RPC. A page SDK can prepare a
page-business question and save its draft. Only the trusted App input owner can confirm
the actual person's explicit submission to the original Agent target. An Agent, page
script, source field or HTTP request cannot self-author Human or answer a Provider-native
permission/question through this module.

In the App's injected Browser, window.capsule exposes capabilities(), theme(), request(),
read(), saveDraft(), inspectOperation(), createOperationId() and onThemeChanged(). Keep an
operation ID before issuing a mutation. The SDK derives its page and target from the exact
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
