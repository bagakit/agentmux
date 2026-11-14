# Profile bookmarks native consumer

The Main/verification runner creates private original Profile metadata and Browser owners, builds
the production preload, and loads renderer.tsx with preview=false. `window.bookmarksNative.api`
is the actual Renderer API; none of its five bookmark methods are replaced. `setProfile` mounts
the production BrowserProfileBookmarks for an exact original Profile summary; `read` reports
visible text/profile identity and `appearance` selects the actual theme runtime.

The Main runner owns source files, file dialogs, Browser creation, public RPC/CLI calls and process
restart verification. Native input exercises the real Title/Address form, folder browsing, exact
Browser selector, import/export and original receipt lookup. Fixtures use synthetic addresses;
receipts and errors must not echo complete URLs or local source/destination paths.

The surrounding settings page and narrow/dark/light presentation are independently captured by
`capture-browser-profile-bookmarks.mjs`. This native page proves the real component/preload/Main
chain and must be combined with original-owner persistence/identity assertions; its title alone
cannot establish those facts.
