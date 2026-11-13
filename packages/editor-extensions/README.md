# Editor extensions

AgentMux's reusable file formats, previews and readers. Desktop consumes this package; Core does not depend on it.

- `catalog` is inert format metadata. Discovery must not load a parser or UI.
- `engines/*`, `ui/*`, `pdf` and `books` are separate leaf entries. Consumers import the selected preview dynamically. Worker entry URLs live next to the engines that own them.
- `bytes` defines a random-access byte source. The host owns file identity, permission, cancellation and closing. PDF and ZIP-backed books request ranges instead of making a capped whole-file snapshot.
- `build/*` supplies local engine assets and upstream notices to the host bundler. Diagram engines that require a document stay in the host's isolated renderer.

The host retains FileDocument, unsaved edits, save actions, Workspace resources, compilation, layout, focus and persistence. Preview props expose the particular host operations needed by that view; the package has no application Store, Electron bridge or duplicate File identity. Reusable React UI uses the client-ui theme and controls.

Readers release section URLs and pending work on hide, retarget and close. Reflowable XML formats and older MOBI variants may require format-wide parsing; CBR may require a sequential native archive scan. These costs are format properties, not a promise that every format is constant-time. DjVu runs in a disposable worker and releases each native page operation. Encrypted or unsupported variants report a recoverable read failure on the original File.

Selected Foliate source retains its MIT license and upstream provenance in `src/books/vendor/foliate`. DjVu runtime assets retain their MIT license and complete Rust dependency notices in production output. Drawio and other engine assets retain their existing licenses. Reference application shells and library databases are not runtime dependencies.
