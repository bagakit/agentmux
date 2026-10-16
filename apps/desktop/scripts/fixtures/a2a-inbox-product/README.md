# Private A2A product proof

This fixture is shared only by T-006 Mailbox, T-007 integration and T-009 restart. The sole builder is `scripts/lib/a2a-inbox-product-proof.mjs`; the ordinary task commands consume its exact artifact through `.tmp/mailbox-reading-flow/receipt.json` → `productArtifact: {path, sha256}`. A missing artifact or review fails explicitly. No previous protocol or old fixture mode is accepted.

`node apps/desktop/scripts/lib/a2a-inbox-product-proof.mjs --prepare` creates a private committed product build and prints its artifact address. It does not mark a gate passed. It uses the production application manifest, Main registration, preload, Renderer, Core, public CLI and pinned ctxmux artifacts. Internal workspace packages resolve privately; installed external dependencies and immutable large assets are read-only inputs. Raw source, actual compiler input, compiled bytes, native artifact and fixture identities are recorded separately. The only private Main adaptations are a nonactivating window and a controlled `electron.clipboard.writeText` OS port. The original UI → preload → production IPC passes its exact text to that port; this does not test the OS clipboard itself. The user clipboard is neither read nor written.

The native executable is explicitly synthetic. It implements the existing qualified authenticated Codex 0.163 actor protocol, writes the canonical `UserMessage` and original opaque `client_id`, and returns actual admitted/rejected/lost native receipts to Core. Core owns claims, adoption, authors, journal, queues and recovery. No fixture writes message journal states or manufactures native adoption, model replies, user authority or a new delivery mode. This proves product protocol wiring; actual model cooperation belongs to T-008.

Electron resolves its system home independently of `HOME`. Each genuine application launch pauses at the unique compiled `SCRATCH_BACKING_PATH` declaration, after imports and before home-backed configuration initializes. The fixture uses the public Electron `app.setPath('home', privateHome)` API on that original call frame and then resumes. The original pause, breakpoint, production snapshot `localHome` and actual spatial catalog must confirm isolation. Environment variables alone do not qualify it.

The production configuration get/save CAS path switches App appearance for twelve actual Mailbox captures: dark and light, all three pages, and wide and narrow viewports. The original appearance object is restored afterwards, preserving authored defaults. Captures record the rendered theme; no DOM style or preview replaces the production theme owner.

The first actual App constructs its workface with public operations and creates an unsent queue and draft with real editor input. The first detached Electron process is killed while the original healthy Runs remain outside its process group. The second actual App starts ordinarily with the same private home and storage and no seed/rehydration controls. Tab membership changes from unique B to B+C through `agent.open --split right`; a same-MID retry must retain its original B route. It does not claim an occupied Region was replaced.

After capture an Agent independent of the product UI author must actually open every listed PNG and write `review.json` beside the raw artifact:

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

All frames must appear exactly once. Rejected or missing frames require correction and recapture; capture alone is not visual acceptance. Retained private build bytes are checked by the three gates before those reproducible build files may be cleaned. Necessary receipts and screenshots remain evidence; private Runtime processes are always reaped by exact owned paths/identities, including on failure.
