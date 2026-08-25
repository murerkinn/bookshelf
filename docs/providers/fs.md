# The filesystem provider

Keeps your library in a directory. No account, no network, nothing to sign up
for — for a machine on your own network, or a VPS you run the app on.

## Setting it up

Point the config at a directory:

```jsonc
// bookshelf.config.json
{ "storage": { "provider": "fs", "directory": "shelf-data" } }
```

Then publish and run:

```bash
npm run sync -- --create   # creates shelf-data/ and publishes into it
npm run build
npm start -w @bookshelf/app
```

Your shelf is on <http://localhost:3000>.

| key | what it does |
| --- | --- |
| `directory` | where the published library lives. Relative paths resolve from the project root |

Keep that directory out of your repository. `shelf-data/` is already gitignored.

## Rebuild after you change the config

`bookshelf.config.json` is read at build time and baked into the bundle, so if
you change `directory` you have to `npm run build` again before the app picks it
up.

To point a running deployment somewhere else without rebuilding, set
`BOOKSHELF_PROVIDER` and `BOOKSHELF_DIRECTORY` at startup. Those override what
was baked in.

## Encrypting your library at rest

`directory` is just a path, so put it inside an encrypted mount:

```jsonc
// bookshelf.config.json
{ "storage": { "provider": "fs", "directory": "/mnt/shelf" } }
```

[gocryptfs](https://github.com/rfjakob/gocryptfs) and
[Cryptomator](https://cryptomator.org) both work. There's no flag to set and no
change to the app.

**Know what this protects.** It covers a disk that gets stolen, a backup that
ends up somewhere it shouldn't, and a host that can read your filesystem but
isn't running your app. It does **not** protect your library from the machine
serving it — the mount is open exactly while the app is reading through it. And
it does nothing for R2, where your storage isn't a filesystem at all.

Expect publishing to be slower into a FUSE mount: books are copied there rather
than hard-linked.

## Troubleshooting

**Your shelf is empty and you built for Cloudflare.** Building for Cloudflare
and then starting the app on Node doesn't fail outright — it shows you whatever
the local miniflare bucket holds, which is usually nothing. The app detects this
and says so at startup. Set `provider` to `fs` and run `npm run build` again.

**The app won't start, saying it has no directory.** A filesystem build with no
directory configured fails deliberately rather than serving an empty shelf.
Check `storage.directory` in your config, or `BOOKSHELF_DIRECTORY`.

**Permission denied writing to the directory.** The app writes profiles and
reading positions into `.bookshelf/` inside it. Make sure the user running the
app owns it:

```bash
chown -R youruser /srv/bookshelf
```

If the directory genuinely can't be written to, the shelf still serves books —
reading positions just stay in your browser.
