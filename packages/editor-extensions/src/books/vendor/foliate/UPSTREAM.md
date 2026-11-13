# Foliate book adapters

These source files are derived from [foliate-js](https://github.com/johnfactotum/foliate-js) at commit `78914aef4466eb960965702401634c2cb348e9b1`, under the adjacent MIT license. `upstream.json` records the original and adapted file hashes. The original module filenames are retained so upstream changes remain reviewable.

The package uses only format adapters and EPUB CFI helpers. It does not copy Foliate's application, viewer, PDF adapter or UI.

Local changes:

- Inject one per-book object URL owner into the EPUB loader, MOBI/KF8, FB2 and CBZ adapters. Section unload invalidates cached documents; closed resources can be loaded again without retaining revoked URLs.
- Retain one format-owned resource lifetime: deduplicate concurrent EPUB assets, keep in-flight MOBI/KF8 section interests, and break cyclic resource wait dependencies without serializing unrelated chapters.
- Sanitize generated section documents and declare a restrictive content CSP. Scripted book content, external resource requests and archive traversal receive no host authority. Host readers must still render book content in an unprivileged sandbox.
- Preserve CBZ entry identity while matching image extensions case-insensitively; emitted image documents share the package fixed-page fit style.
- Make FB2 chapter URLs lazy and keep its small default stylesheet owned by that book instead of creating a global import-time URL.
- Reject MOBI's protocol encryption flag explicitly before text decoding. No DRM removal or encrypted-book support is provided.
- Keep MOBI's record-slice input contract. Legacy MOBI6 requires decoding its text records together; KF8 loads text by section. FB2 is a single XML document and requires an initial XML parse. Those format costs are not represented as whole-file streaming.

The host owns the original read-only byte source, access policy and closure. DOM-backed parsing runs in the isolated reader document realm; these adapters do not turn `DOMParser` into a Worker or imply that a Promise timeout cancels synchronous parsing. `destroy()` aborts this book's byte reads and releases owned URLs, while the host releases the original source separately.
