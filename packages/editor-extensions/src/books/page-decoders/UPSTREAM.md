# Fixed-page decoders

## DjVu

The decoder is the MIT-licensed `djvu-rs` npm distribution, pinned to `0.43.0`, from [matyushkin/djvu-rs](https://github.com/matyushkin/djvu-rs). Qualification used source commit `0a3d5a31f3d54435bebbe4a500e209a65f7df9ce` and the actual published scalar/SIMD WASM artifacts. The npm tarball integrity is `sha512-ytzRFFeUzCY2WcxEYzTpw0L9ziC0KmSJ7JPmFOG8EMy2BtJwn/5g6hfk5cenGi5g8spzvbgAMX4pnWQBZ9i0rA==`.

The npm `LICENSE` and `THIRD_PARTY_NOTICES` cover the Rust decoder and its statically linked dependencies and must accompany the emitted WASM. This implementation does not incorporate the GPL DjVu.js decoder or change AgentMux's license.

Only the chosen scalar/SIMD engine is instantiated, lazily in a dedicated Worker. The engine's lazy document indexes the original byte source using ranges. Its native document cache retains visited parsed pages, so this consumer opens and frees a document for each operation, while retaining one initialized engine. Owned pixels are copied before freeing the WASM pixmap; a borrowed WASM view never crosses the Worker boundary. Display scale targets four million pixels and at most 150 DPI through the upstream integer-DPI API. This controls the current output allocation; it is not a strict bound on native page decoding memory, original file size or native page dimensions.

Unloading an in-flight page terminates its Worker and aborts its original reads. The next requested page can start another Worker. Closing the book terminates the engine; the Host separately owns and releases the original source. Bundled documents are supported. Indirect documents requiring separately authorized external files are not resolved through arbitrary network or filesystem access.

## Comic RAR

The Host uses its installed libarchive-compatible `bsdtar` to convert the original pinned descriptor to a PAX stream. `tar-stream`, MIT, parses binary headers, checksums and extended path/size records. No human listing, glob pattern, temporary extracted directory, reopened pathname, shell command string, or whole-archive JS/WASM buffer participates in entry identity.

RAR names are interpreted by libarchive's format semantics; for example, its RAR decoder normalizes a backslash separator to `/`. Both listing and page reading use the same resulting PAX identity. Duplicate image identities and paths that cannot be represented unambiguously in UTF-8 are reported for that operation. The original file remains available.

RAR decoding is sequential through the native tool. Listing drains entry data without collecting it; opening a late page may rescan preceding compressed entries. Only the selected encoded page is collected in JS, and the browser keeps one page document/image URL. This is bounded page consumption, not a claim of random access to compressed RAR entries. Unsupported Host tools, encrypted or incomplete archives report their actual decoder failure. No password guessing, DRM removal, native application shell, or new system package is involved.

`verify-page-decoders.mjs` exercises original RAR page pixels, machine names, descriptor lifetime, page cancellation, URL release, actual Chromium DjVu Worker/WASM output, range requests, repeated-visit memory and source mutations. The full File/Host/isolated-reader product consumer and visual review remain the owning Desktop integration's responsibility.
