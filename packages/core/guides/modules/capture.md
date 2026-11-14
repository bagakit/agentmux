---
summary: "Region scrolling captures and GIF recordings with embedded keyframe notes"
roles: "Authorized operators of a Host with a Desktop capture owner"
when: "Open a manual scrolling capture or GIF recording, inspect or stop the original operation, or read its saved artifact"
---

# capture

<!-- amux:content -->
Use `amux capture sequence ACTION --help` for exact arguments. Open takes
`{hostId,operationId,mode:"scroll"|"gif"}` and presents a region picker and capture
controls. The user explicitly starts recording or continuous scroll sampling, or captures individual frames after scrolling; opening
a sequence does not scroll another app or begin unattended recording.

Keep the original operation ID. Inspect and read never replay a selection or
recording. Stop ends sampling and preserves captured frames for review. A missing
receipt is unknown; keep the original operation instead of retrying open with a new
identity. Read returns the exported PNG or GIF as `artifact:{mimeType,data:BASE64}`.
The GUI and these commands share the Desktop owner; none sends a draft.

GIF exports contain an `AMUXGIF1001` Application Extension with schema
`agentmux.gif.v1`, width, height, per-frame delays in milliseconds and
`keyframes:[{frameIndex,note}]`. Frame indices are zero-based; the GUI displays
one-based numbers. Reopening the file restores notes without a sidecar. Ordinary
GIF players keep playing; external re-encoding may strip extension metadata.

Read accepts optional offsetBytes and maxBytes (1–8388608; default 8 MiB). Artifact pages carry offsetBytes, totalBytes, nextOffsetBytes and the whole-file sha256. Continue the same original operation and checksum until nextOffsetBytes is null. This keeps large images within the RPC frame budget.
