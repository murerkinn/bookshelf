# Storage providers

Where a library lives is the one thing this project expects to be swapped. A provider is a package, named in `bookshelf.config.json`, and it does not have to be one of the two shipped here.

A provider is a package, not a file in the CLI. `providers.mjs` maps the short
ids to the packages shipped here and imports anything else as given, so a
provider written by someone else needs nothing added: install it, name it in
the config, done.

Each provider has two faces, because the app and the CLI run in different places
and want different things:

```
@bookshelf/provider-r2           its manifest — id, options, capabilities
@bookshelf/provider-r2/worker    Storage: head, read, readBytes, readRange,
                                 and optionally write, remove
@bookshelf/provider-r2/node      StorageAdmin: read, put, remove,
                                 and optionally create, list, removeAll
```

The manifest is importable without credentials or a runtime, which is what lets
the CLI name a provider's settings, and the docs describe them, without
connecting to anything.

Entry points are named for the runtime they need rather than the face they
implement. R2 splits across two, because the app reads it from workerd and the
CLI writes it from Node. The filesystem provider has one, `/node`, because both
of its halves need a filesystem — and that is the same fact as the app having to
run on a machine that has one.

| | `r2` | `fs` |
| --- | --- | --- |
| read | Worker binding | `node:fs` |
| publish | wrangler CLI | copies, hard-linked where it can |
| `create` | `wrangler r2 bucket create` | `mkdir -p` |
| `list` | — | walks the directory |
| `removeAll` | — | empties the directory |
| app can write | binding `put` | atomic rename |
| credentials | a wrangler login | none |

`create`, `list` and `removeAll` are optional because providers genuinely differ
in what their APIs offer, and the alternative to optionality is a provider that
lies. The two shipped here differ in exactly that way, which is the point of
having two.

## The two shipped here

- [Cloudflare R2](r2.md) — a bucket, read from a Worker
- [Filesystem](fs.md) — a directory, read from a Node server

Writing one is covered in [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-storage-provider).
