# Auth

This editable local Toolkit package reads the selected account's reported usage. Its default arguments are `codexL` and `@active`. Only an explicit Run invokes the query; installing, saving, enabling or watching it does not query an account.

`query.mjs` receives the query executable, then either `@active` or an exact `account_key`, followed by optional query arguments. Without extra arguments it runs `as-inspect auth status --scope global --skip-api --json`. To use another CLI or output format, edit `queryArguments`, `decodeQueryOutput` and `readAccounts` in this directory. Editing `manifest.json`, the entry or helper files takes effect on the next explicit run.

`@active` requires a nonempty global `active_account_key` that matches exactly one account row. Missing, duplicate or inconsistent identity is unknown; the package never selects the first account. The external source's global account does not prove which account an existing Agent Run uses.

The result distinguishes natural window resets, available reset cards and card expiry. Missing fields remain “Not reported”; a reported zero remains zero. Values are a snapshot from the external query, with its source and refresh facts, rather than a claim of live freshness. The query may update that CLI's own local snapshot. This package does not log in, renew credentials, switch accounts or use reset cards.

AgentMux initially copies this whole directory to a writable local user package directory and saves an ordinary reference. Existing configuration and existing directories are not replaced. The package directory and execution cwd are separate: change cwd and arguments through Toolkit preferences, and change source by editing the files here. Deleting the saved tool or editing its files is preserved when AgentMux restarts.
