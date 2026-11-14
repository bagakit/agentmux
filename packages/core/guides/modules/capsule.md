---
summary: "Durable local pages, conversation display and page questions the person answers"
roles: "Agents publishing local page artifacts and authorized people managing their pages"
when: "Publish, open or diagnose a generated local page, or ask the person to compare, choose or fill something on a page"
---

# capsule

<!-- amux:content -->
The Capsule owner holds each original page, its saved content or external path, creation
defaults, stable endpoint and retained operations. A Capsule ID identifies content; a
Browser, Tab or Region identifies its display. Names, paths, ports, producer source fields
and amux links do not authenticate a caller or grant input permission.

Use this module for static HTML, assets, existing frontend build output and explicitly
selected SPA routing. It does not run a build command, backend or development server.
Managed storage copies content into the Host's durable library; path storage follows an
exact external directory and reports missing content instead of serving an empty page.
Storage mode and isolated/injected display mode are independent.

## Publish and open a page

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
  Before opening, read amux space --skill and browser --skill. With an attached Region,
  normally pass an explicit readable split in the same Tab instead of relying on the
  Desktop's new-Tab default when placement is omitted; preserve the user's new-Tab/tool
  choice and real layout exceptions. Reuse the confirmed Browser. Read rendering.status: only
  an available rendering returns exact Browser/Tab/Region IDs, and it confirms presentation,
  not Agent delivery. amux capsule open --help gives the placement JSON and unknown-result recovery.
- amux capsule operation inspect --input FILE reads {operationId} without replaying it.

To show a saved page in an AgentMux Desktop conversation, write its returned
amux://capsule/ID, [Title](amux://capsule/ID) or ![Title](amux://capsule/ID). A paragraph
of only page references shows the pages in place; in a sentence, heading, list, quote,
table or footnote the text stays and the page follows its block. One URI repeated in a
block shows one page. Code and math stay literal. Read-only and external chat clients keep
the link; share an ordinary link there. For conversation pages prefer "mode":"injected" and
"theme":"follow" so the page uses the App's theme variables; choose isolated for
independent styling. The card loads only while visible and never starts a stopped service;
the person can Hide, Expand or Open in Browser, and hiding never deletes the page or draft.

Bare `amux://capsule/ID` addresses the current local Capsule namespace. To share a page
with a viewer on another node, use the original published Node-qualified Capsule link
and retain its Runtime pin. A Host label or a bare Capsule ID cannot name that remote
owner. Use the confirmed Node address; do not invent an alias or replace the pin with
the viewer's local Runtime. Node-qualified links request a local access view, rather
than silently embedding a remote loopback URL as a local conversation page.

## Ask the person on a page

A page question lets the person look, compare, choose or fill in, then send one confirmed
answer back to the page's recipient Agent. Prefer it to a chat question for visual
candidates, side-by-side layouts, long option lists or a small form. Ask in chat for one
short text answer, for Provider-native permission or question answers, and for secrets:
the answer arrives as ordinary input text.

1. capsule create. The recipient defaults to you, the authenticated calling Agent. Pass
   target {hostId,agentSessionId} only for another exact Session. It is fixed at creation;
   a page created without a recipient cannot gain one, so create a new page.
2. Before sharing the link, ask with capsule interaction request
   {capsuleId,operationId,question,draft?}. The returned interaction must have a target.
   Questions work on isolated and injected pages; on an injected page, page script may also
   ask with window.capsule.request() after checking capabilities().interaction.
3. In the original local namespace, post amux://capsule/ID and tell the person to answer through the page's Questions
   button. End your turn and keep your Session running; do not poll.
4. The person edits and confirms in trusted App chrome. It arrives as your next input:
   <amux:capsule-answer version="1">
   {"capsuleId":"Kd7mQ2xRb9Wp","interactionId":"Q4nT8vHc2Jzs","question":"Which icon?","answer":"B"}
   </amux:capsule-answer>
   It answers only that question. capsule interaction inspect with those IDs reads its
   status, answer and reply.delivery.

A form page can write the person's selections into the draft with saveDraft(); the person
still reviews and confirms. The Questions list refreshes when the card is visible or opened.
If your Run is not running when the person confirms, the answer is kept and the App reports
SESSION_NOT_RUNNING. An Agent, page script, source field or HTTP request
cannot self-author Human input or answer a Provider-native permission or question: capsule
interaction reply is refused for Agents and pages. Saving, submitting and the Agent adopting an
answer are separate results.

## Page script on injected pages

Isolated pages get no App theme and no page script API. Injected pages get only what their
Host grants; neither mode exposes Electron, Node or arbitrary RPC. In the App's injected
Browser, window.capsule exposes capabilities(), theme(), request(), read(), saveDraft(),
inspectOperation(), createOperationId() and onThemeChanged(). Before each mutation keep an
ID from createOperationId() and pass it to request(question, draft, operationId) or
saveDraft(interactionId, expectedRevision, draft, operationId); use undefined for no draft.
Persist the ID first when recovery must survive a reload. Missing IDs are rejected before
dispatch. After an unknown result, call inspectOperation(originalId); never mint a new ID
or resend. The SDK derives its page and target from the exact native document and has no
reply or approval method.

## Pages from another configured node

Desktop can present an authorized Capsule from another configured node through its
original Runtime identity. The original node still owns its content, revision, service
instance, requests, drafts and operations. Its `127.0.0.1` address is not an address on
your computer. Desktop carries authorized asset bytes through a private local loopback
endpoint; the remote service remains loopback-only. Relative files, MIME types, SPA
navigation and GET/HEAD retain the original Capsule rules. The local carrier is not a
general file server, arbitrary URL proxy or permission grant.

`capsule asset read --input FILE|-` reads one bounded chunk from an existing Capsule:
use its exact `capsuleId`, `expectedRevision`, `expectedInstanceId`, URL `path`, byte
`offset` and `length`. Obtain the revision and service instance from `capsule inspect`.
Continue with the returned `assetStamp` until `eof`; retain the same stamp throughout
one asset. A changed asset or owner requires a fresh read of that same page, not mixed
bytes from different versions. The single-message bound does not limit total asset size.
This method uses the same authenticated public transport as other Capsule operations.

Remote isolated pages have no SDK. Remote injected pages retain the native document
checks and SDK request/read/saveDraft/inspectOperation capabilities on the original
node. Neither the link, page script, asset carrier nor an Agent can certify Human
input. Cross-node Human confirmation is not provided: review and confirm in the
original node's trusted App. The remote Questions panel retains and saves original
drafts without submitting Agent input. Existing local Capsules keep their original
storage partition and data; new remote containers use Runtime-plus-Capsule identity and
restore their original local origin. An unavailable original port or Host retains the
same Browser workface and recovery path rather than silently changing its data origin.

## Service and recovery

The Capsule runtime is one independent service carried by an ordinary ctxmux Run. Core
keeps its running/stopped intent and keepalive; headless Core provides the same. Closing
the App or stopping Core only detaches management; a healthy service keeps serving. Paths
and 127.0.0.1 belong to the execution Host; a remote Core does not expose its loopback
server or create a network tunnel. Desktop presentation uses the authorized carrier
described above. Only the first capsule create
or an explicit runtime start sets running intent; other calls on an unconfigured namespace
return CAPSULE_RUNTIME_UNCONFIGURED. Reads never start, stop or rebind the service. For
start, stop, unknown results and stranded-creation recovery, read capsule runtime inspect,
start and stop --help and use their exact revision, Run and recoveryTarget. A Toolkit TUI
kit may wrap these commands; closing that tool does not stop the service.

Keep page, request and answer identities and the original operation after an unknown
response; read that operation before any next action. Service, theme or input failures
keep the page, draft, original workface and healthy Agent. Capsule removal and content
deletion are explicit, distinct effects; external path content is never deleted.
