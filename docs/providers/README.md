# Storage providers

A provider decides where your library lives. Two ship with the project, and you
can install someone else's.

## Choosing one

| | [Cloudflare R2](r2.md) | [Filesystem](fs.md) |
| --- | --- | --- |
| your library lives in | an R2 bucket | a directory on disk |
| the app runs as | a Cloudflare Worker | a Node server |
| you need | a Cloudflare account | nothing |
| costs | R2 pricing | nothing |
| good for | reaching your shelf from anywhere | a machine on your own network, or a VPS |

Pick `fs` if you want to own the whole thing and have somewhere to run it. Pick
`r2` if you'd rather not run a server.

## Setting one

Name it in `bookshelf.config.json`:

```jsonc
{ "storage": { "provider": "fs", "directory": "shelf-data" } }
```

```jsonc
{ "storage": { "provider": "r2", "bucket": "books" } }
```

Everything under `storage` other than `provider` belongs to that provider. See
its page for what it accepts.

## What each one can do

| | `r2` | `fs` |
| --- | --- | --- |
| serve books | yes | yes |
| resume an interrupted download | yes | yes |
| create the destination for you (`--create`) | yes | yes |
| `--force` clears the destination completely | no — see below | yes |
| the app can write profiles and positions | yes | yes |
| credentials to set up | a `wrangler login` | none |

On R2, `--force` removes what the last catalog recorded rather than everything
in the bucket, because wrangler can't list objects. If you've put things in that
bucket by other means, `--force` won't touch them. The sync tool says which
guarantee it gave you.

## Using a third-party provider

Install it and name it:

```bash
npm install some-bookshelf-provider
```

```jsonc
{ "storage": { "provider": "some-bookshelf-provider", "...": "..." } }
```

Anything that isn't `r2` or `fs` is imported as given, so there's nothing to
register.

## Writing your own

See [CONTRIBUTING.md](https://github.com/murerkinn/bookshelf/blob/main/CONTRIBUTING.md#adding-a-storage-provider).
You don't have to contribute it back — a package published by anyone works.
