# The filesystem provider

Holds the library in a directory. Needs no account and no network — for a machine on your own network, or a VPS you run the app on.

The filesystem provider is what makes the app runnable on a machine you own — a
box on your own network, or a VPS — with no account anywhere.

```jsonc
// bookshelf.config.json
{ "storage": { "provider": "fs", "directory": "shelf-data" } }
```

```bash
npm run sync -- --create   # publishes into shelf-data/
npm run build
npm start -w @bookshelf/app
```

No environment variables: **`next.config.ts` reads the same
`bookshelf.config.json` the sync tool reads, at build time, and bakes the
provider into the bundle.** One file decides where the books go and where the
app looks for them, which is the only way the two cannot disagree.

It has to be build time rather than request time. On Workers there is no
filesystem to read a config file from, and the two modes are different artifacts
anyway — one Worker, one Node server. `BOOKSHELF_PROVIDER` and
`BOOKSHELF_DIRECTORY` still override at startup, for a deployment whose library
sits somewhere other than where it was built.

`getServices()` imports each provider dynamically, because the two are not
interchangeable at run time: one needs a Worker binding, the other a filesystem,
and whichever the deployment lacks must never be loaded.

Keys arriving from URLs are resolved against the library root and rejected if
they escape it, so `../` in a request cannot reach a file outside the published
tree.

There is no Workers cache in this mode, and none is needed: the catalog memo
still spares the repeated reads, and the files are already local.

## Choosing wrong

Building for Cloudflare and then starting the app on Node does not fail, which
is the trap. `getCloudflareContext()` quietly returns a local development proxy,
so the shelf renders — showing whatever the local miniflare bucket holds rather
than what is in R2, and looking merely empty rather than misconfigured.

The app detects that case (a Node process, in production, with no Cache API) and
says so on startup. A Worker with no `BOOKS` binding, and a filesystem build
with no directory, both fail outright with what to do about it.

Because a directory can be walked, this provider implements every optional
capability: `--force` empties the destination for real rather than falling back
to the keys the last catalog recorded. Same flag as R2, same code path in the
sync, a different guarantee — stated rather than assumed.
