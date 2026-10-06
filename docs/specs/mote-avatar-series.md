# Avatar series sources

The owning behavior is [Mote avatars](../design/behavior/motes-and-coordination.md#mote-头像与主-mote); presentation is owned by [Mote avatars](../design/presentation/motes-and-coordination.md#mote-头像与主-mote). This page defines the public data consumed by the original Host source owner.

## Put a collection on the Host

Use `~/.agentmux/avatars/<series>/`. Regular PNG and JPEG files appear without a manifest. Packaged collections have `origin: "builtin"`; this directory has `origin: "user"`. Those origins remain distinct even when directory names match. Discovery reads directory metadata and declarations, not every artwork file. The catalog reports missing/unavailable roots and local issues explicitly.

An optional `series.json` can mix images, original 2D face presets and self-contained GLB models. Undeclared regular images remain available. A malformed entry does not hide other images.

```json
{
  "schema": "agentmux.avatar-series.v1",
  "title": "My collection",
  "entries": [
    {"id": "owl", "title": "Owl", "definition": {"kind": "image", "file": "owl.png"}},
    {"id": "quiet", "title": "Quiet", "definition": {"kind": "face2d", "face": {
      "kind": "face", "shape": "soft", "palette": "slate", "eyes": "calm",
      "brows": "straight", "mouth": "small", "accessory": "none"
    }}},
    {"id": "geometric", "title": "Geometric", "definition": {
      "kind": "glb", "file": "companion.glb",
      "materials": [{"index": 0, "role": "shell"}, {"index": 1, "role": "graphic"}],
      "morphs": [{"id": "expression", "label": "Expression", "meshIndex": 0, "targetIndex": 0}],
      "framing": {"nodeIndex": 0}
    }}
  ]
}
```

The example GLB indices must be replaced with indices that actually exist in that model. Names and labels are display text. `materials` bind native material indices; `morphs` bind native mesh and morph-target indices. `framing` chooses an original model node for the view. Optional controls are absent when not declared. Files are exact relative paths inside the same original regular directory. Links, remote resources, executable code and custom shaders are not source capabilities.

2D values use the existing pure [face schema](../../packages/core/src/mote-face.ts). GLB geometry, rigs and morphs are loaded by the pinned Three.js GLTFLoader; standard PBR/Toon materials provide the implemented material controls. The source owner checks the actual container, references and declared machine indices. Rendering can still report a local unsupported model; preparation never claims rendered pixels.

## Public readers

`amux space mote avatar series create --series my-collection --title "My collection"` and JSON-RPC `space.mote.avatar.series.create` take `{seriesId, title}`. They create one previously absent user directory under the original Host avatar root, containing `starter.png`, `series.json` with an image and original face preset, and `README.md`. The starter image is read and validated from the packaged low-poly owl before the user source tree is changed. The result is `{seriesId, title, path, files, state: "created"}`; `files` contains the exact relative filenames. Existing directories, files and links refuse this particular creation without replacing their content. A later write failure preserves any new partial content. There is no automatic retry, cleanup, avatar publication or Agent operation. Without a complete reply, read the original catalog to observe the current source; directory presence cannot confirm an earlier lost creation receipt.

`amux space mote avatar series reveal --series my-collection` and JSON-RPC `space.mote.avatar.series.reveal` take `{seriesId}`. They check that exact regular directory under the same user root and invoke the Host OS folder port. The result `{seriesId, path, outcome: "requested"}` acknowledges the request only, not an opened window, visibility or focus. A missing port or OS failure affects only this action, retaining created files and the source readers. Create and reveal use the same typed source/control owner and trusted Desktop IPC as the readers below; neither accepts an arbitrary root or path.

`amux space mote avatar list` and JSON-RPC `space.mote.avatar.list` take no parameters. Their result is `{roots, series, issues}`. A root is `{origin, path, state}` with `state` available/missing/unavailable. A series contains `{origin, seriesId, title, entries}`; each entry contains `{entryId, title, definition}`. Original PNG/JPEG filenames are entry IDs when there is no explicit declaration.

Issues contain `{code, message, recovery}` and may identify one exact `source`. Repeated errors of the same class within a collection are summarized with an accurate positive integer `count` and up to three actual examples. A summary identifies the declaration or directory in its message and has no invented entry locator. All valid entries remain in the catalog. Preview returns declaration summaries and issues for the selected source, excluding unrelated individual sibling errors.

`amux space mote avatar preview --input source.json` and JSON-RPC `space.mote.avatar.preview` take:

```json
{"source": {"origin": "user", "seriesId": "my-collection", "entryId": "owl.png"}}
```

Add `expectedRevision: "sha256:<64 hex>"` to require one exact previously prepared version. The result is `{source, definition, payload, issues}`. `source` retains the locator plus `revision`, derived from the canonical definition and actual selected file bytes. A different revision is an explicit conflict. Image payloads contain the original native decoder's bounded PNG preview; 2D payloads contain the original face; GLB payloads contain the validated original bytes as `dataBase64`. The SDK's strict result decoder retains the requested locator/version.

These readers share the same Main business owner with trusted Desktop IPC and the ordinary default Host forwarding path. Source discovery and preview create no Mote, AgentSession or Run and publish no appearance.

## Read and save one original Mote

Discover the exact `{workspaceId, topicId, objectKey}` from `amux app snapshot --include motes`. Pass that tuple as `target` to `amux space mote avatar read --input target.json` or JSON-RPC `space.mote.avatar.read`. The result contains the original `choice`, an opaque `revision`, issues, and the saved bounded PNG when available. Series choices retain the exact source locator and content revision, definition, editor parameters and original image reference. Other authored choices remain readable, including records this editor cannot interpret.

`amux space mote avatar save --input request.json` and JSON-RPC `space.mote.avatar.save` accept `{target, operationId, beforeRevision, source, definition, parameters, pngDataUrl}`. Use the revision from the original target read, the exact prepared source version and one UUID for this request. `pngDataUrl` is the caller's selected 256×256 PNG frame; Main validates and saves it through the original object-image owner. The service does not independently render or certify that those pixels depict the supplied GLB parameters. The original configuration owner publishes the choice and owns per-object publication revisions, so a later A→B→A edit still conflicts with an older baseline. Edits to other objects continue to merge.

The result is `{state, operation?, issue?, current}`. `saved` requires the original configuration publication and its disk durability acknowledgement. `refused` means this request was rejected; the draft and current original appearance remain available. `unknown` retains the exact original request and operation while publication or acknowledgement cannot be confirmed. Source preparation, PNG creation, current-choice observation and confirmed publication are distinct facts.

To inspect an uncertain save, read `{target, operationId}`. To retry it, resend the identical frozen request with the same UUID. Replacing the body under that UUID is refused. An operation journal records that request's history inside the original Mote directory; it is not another current-choice store. Once publication is uncertain or recorded, retry does not publish again. A historical confirmed receipt can coexist with a later `current.choice`; consumers retain that later choice.

Missing or changed mods leave the saved PNG and parameters intact. The read's optional `source.state` is `available`, `unavailable` or `changed`; reopening the editor requires the exact saved source version. Discovery, read and save do not change the Mote's identity, workspace, SOUL, Session, Run, Tab or Region.

## Single-input resource boundaries

Image processing retains the original 8 MiB input, 4096px side, 16MP decoded and 2 MiB preview boundaries. A selected GLB is at most 32 MiB; this protects parser/renderer memory and fits the original 64 MiB RPC frame after base64 encoding. Its embedded PNG/JPEG images retain the original per-image boundaries; both embedded-image decoding and native texture slots have a 16MP aggregate budget for that selected model. These are source preparation limits, not cumulative catalog limits. Discovery does not truncate valid collections by total entry count or a fixed scan deadline.

Save accepts a PNG of at most 512 KiB before base64 encoding. A single operation record has a 32 MiB read boundary; this is independent of the number of collections or earlier operations.

The executable public types and strict codecs are [mote-avatar-series.ts](../../packages/core/src/mote-avatar-series.ts) and [mote-avatar-write.ts](../../packages/core/src/mote-avatar-write.ts). Actual source preparation belongs to [Main](../../apps/desktop/src/main/mote-avatar-series.ts); saved choices use the original owners through [the native writer](../../apps/desktop/src/main/mote-avatar-writer.ts).
