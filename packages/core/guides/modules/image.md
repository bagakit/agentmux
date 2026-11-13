---
summary: "Temporary reference images and their original operation receipts"
roles: "Authorized operators of a Host with a client image owner"
when: "Pin an authorized PNG, inspect its original effect or current presentation, or close an exact reference image"
---

# image

<!-- amux:content -->
The image module presents a fixed, authorized PNG as a temporary reference window.
The Desktop owns its pixels, window and original operation receipts. Core delegates
typed requests and creates no Browser, Tab, Session, Run or image library. Read
`amux image ACTION --help` for the exact JSON arguments of this version.

Pin requires the exact hostId, an original operationId and an embedded PNG image
with format, base64 data, actual width and height, and scale 1. It captures no screen,
reads no URL or file, and grants no new system or Agent permission. Use native capture
for OS pixels or the original Browser's screenshot capability for a page. Keep their
source identities separate from the resulting pin. A hostId never authorizes using
a different computer when the original presentation owner is unavailable.

Keep the returned pinId and creationOperationId. The outer state describes the pin's
current observation; recordedOperation describes one original pin or close effect
and its authenticated actor. An image opened earlier may now be closed without
changing the original opened receipt. Inspect by operationId to reconcile an unknown
request, or by pinId to read that exact image's current state. Choose only one selector.
A null original record, a missing current window or an interrupted reader cannot
prove that an earlier operation did not happen. Never automatically replay an unknown
pin or close request, and never substitute a new operation to conceal the old outcome.

Closing requires that exact pinId and a separate operationId. It affects only that
temporary reference image, preserving its original editor, Browser, draft, Session
and Run. The pin's copy and save actions use its own fixed processed pixels; later
edits in the source do not silently update it. Save explicitly when the image should
outlive the temporary presentation. Missing window support affects only this module;
existing editing, clipboard, page capture and healthy Agents remain available.
