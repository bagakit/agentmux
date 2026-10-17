# Private A2A reference product proof

`node apps/desktop/scripts/verify-a2a-reference-reading.mjs --prepare` runs the source-bound reading tests and implementation mutations, then builds one complete committed private Desktop candidate. The sole builder is `scripts/lib/a2a-inbox-product-proof.mjs`; its only product workload is `fixtures/a2a-reference-reading/worker.mjs`, using this directory's private Runtime and synthetic native actor. The ordinary bare gate consumes `.tmp/a2a-reference-reading/current.json` and the exact product artifact and independent visual review. Preparation does not mark the gate passed. Mailbox's separate source-only gate checks its components and bridges; it does not consume an older full-body App receipt.

The build uses the production manifest, Main registration, preload, Renderer, Core, public CLI and pinned ctxmux artifacts. Internal workspace packages resolve privately; installed external dependencies and immutable large assets are read-only inputs. Raw source, compiler input, retained compiled bytes, native artifacts and fixture identities are recorded separately. The only Main adaptations are a nonactivating window and the unique `electron.clipboard.writeText` port. The original UI → preload → production IPC passes exact content to that controlled port. This does not test the OS clipboard itself, and the user clipboard is neither read nor written.

The native executable is explicitly synthetic. Its authenticated actor owns the canonical native transcript. A fresh transcript contains one original `task_started`/`task_complete` turn establishing the initial idle opportunity without a user/body input or hand-written Core status. Accepted `thread/queue/add` calls preserve the original input/client correlation in a native `UserMessage` and return the exact queued-submission receipt. Core owns the original Inbox, notifications, input claims, adoption, authors and journal. The fixture does not write Core state, manufacture adoption or claim model behavior, vendor queue-race safety or a new transport mechanism.

Electron resolves its home independently of `HOME`. The actual App pauses at the unique compiled `SCRATCH_BACKING_PATH` declaration, after imports and before home-backed configuration initializes. The fixture invokes Electron's `app.setPath('home', privateHome)` on that original call frame and resumes. The original pause, breakpoint, production snapshot `localHome` and spatial catalog must all confirm isolation. Environment variables alone do not establish it.

The scene follows actual public CLI send → original Core Inbox and independent notification input → qualified native/captured Conversation → Main/preload → production reading. It checks the exact original MID/operation/Run/key, unchanged wire/body Copy, platform notice provenance, reference-only presentation, literal authored protocol examples in Inbox and exclusion from User Messages. Read, Copy and theme/check operations must preserve every private Session's complete native queue/turn/manual-input effect log and exact Agent Inbox batch.

Seven App frames cover a bounded inline notice under dark/light appearance and wide/narrow Desktop viewports, plus original Inbox, Outbox and User Messages. Themes change through the production configuration get/save CAS path and restore the original appearance. Original long IDs must wrap inside the reading face. No DOM styles, preview or injected transcript props replace the product. These frames do not claim a physical phone, a large-resource App state, a process restart or model adoption. Complete resource/body/part/Copy fences are exercised by the actual shared production Resource component in the owning source-bound tests and mutations; Core reopen and native lifecycle proofs remain with their original owners.

An Agent independent of the product UI author must actually open every full PNG and write `review.json` beside the raw product artifact:

```json
{
  "schema": "agentmux.a2a-product-visual-review.v1",
  "reviewer": "canonical native Agent identity",
  "independent": true,
  "openedAll": true,
  "verdict": "pass",
  "productSha256": "SHA-256 of the exact receipt.json bytes",
  "frames": [{ "path": "absolute captured PNG path", "sha256": "exact PNG SHA-256", "verdict": "pass" }]
}
```

Every frame appears exactly once. Rejected or missing frames require correction and recapture; capture alone is not visual acceptance. The bare gate checks the retained private compiled bytes, original fixture/source hashes, actual protocol/consumer facts and exact review before passing. Private processes are reaped by their exact owned identities even on failure. Necessary original receipts, logs, frames and compiled hashes remain evidence; unused failed build outputs may be cleaned only after their ownership and process cleanup are confirmed.
