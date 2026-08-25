# Bookshelf

[![CI](https://github.com/murerkinn/bookshelf/actions/workflows/ci.yml/badge.svg)](https://github.com/murerkinn/bookshelf/actions/workflows/ci.yml)

A self-hosted library for the ebooks you already own. Put your EPUBs and PDFs in
a folder, publish them, and read them in any browser — or on your Kobo, through
the [OPDS catalog](docs/opds.md).

![The shelf: a searchable list of books with covers, a profile switcher, and a Continue button on the book being read](docs/shelf.webp)

Run it as a Cloudflare Worker over R2, or as a Node server over a directory on
your own machine. Both use the same code and the same library.

📖 **[Full documentation](https://murerkinn.github.io/bookshelf/)**

## Try it in a minute

You'll need Node 24 or newer and a Unix-like system. Windows isn't supported —
the sync tool looks for its image tools with `which`.

```bash
git clone https://github.com/murerkinn/bookshelf.git
cd bookshelf
npm install
npm run demo
```

`npm run demo` writes nine generated public-domain books into `books/` — eight
EPUBs and a PDF, so both readers are one click away. It downloads nothing. Then
publish and run them by whichever route below.

The checked-in `bookshelf.config.json` points at Cloudflare R2, so `npm run
sync` goes there unless you change it. For a local look, switch it to the
filesystem provider first:

```jsonc
// bookshelf.config.json
{ "storage": { "provider": "fs", "directory": "shelf-data" } }
```

## Set up your own

Put your books in `books/`, then pick where the library should live.

### With Docker

The shortest route, and the image ships the tools that make covers.

```bash
mkdir books && cp ~/Downloads/*.epub books/
docker compose run --rm sync --create
docker compose up -d
```

Your shelf is on <http://localhost:3000>. Sync flags pass through, so
`docker compose run --rm sync --force` works as it does locally.

Back up the `library` volume — it holds your published books and your reading
positions. To bind-mount a host directory instead, chown it first:

```bash
chown -R 1000:1000 /srv/bookshelf
```

### On a machine you own

No account anywhere.

```jsonc
// bookshelf.config.json
{ "storage": { "provider": "fs", "directory": "shelf-data" } }
```

```bash
npm run sync -- --create
npm run build
npm start -w @bookshelf/app
```

More in [the filesystem provider](docs/providers/fs.md).

### On Cloudflare

You'll need a Cloudflare account. Edit `bookshelf.config.json` and
`apps/bookshelf/wrangler.jsonc` so they name your bucket and Worker — if they
disagree, the sync tool stops before uploading.

```bash
npx wrangler login
npm run sync -- --create
npm run deploy
```

More in [the R2 provider](docs/providers/r2.md).

## Before you commit a library to it

**There is no authentication.** Anyone who can reach your shelf can download
every book in it, and pick any profile while doing it. The
[OPDS catalog](docs/opds.md) makes it machine-enumerable as well. Put it on a
network you trust, or behind something that asks who's calling.

**Nothing is encrypted.** Your library is stored in the clear, and object keys
are slugified titles — a listing of your storage names your shelf. With the
filesystem provider you can keep it on
[an encrypted volume](docs/providers/fs.md#encrypting-your-library-at-rest)
today.

**Two devices reading one profile at once is last-write-wins.**

[What's missing](docs/roadmap.md) has the full list.

## Configuration

| variable | what it does |
| --- | --- |
| `BOOKSHELF_READ_ONLY` | set to `1` and storage keeps serving but stops accepting. Profiles can't be added, renamed or deleted, and reading positions stay in the browser. Set this on anything strangers can reach |
| `BOOKSHELF_PROVIDER` | override the provider the build was made with |
| `BOOKSHELF_DIRECTORY` | override where the filesystem provider looks |
| `BOOKSHELF_SITE_URL` | the public address, for link previews and canonical URLs. Set it behind a proxy that doesn't say so |

Everything else lives in `bookshelf.config.json` — see
[publishing](docs/publishing.md#configure-where-things-go).

## Commands

All from the repository root.

```bash
npm run dev          # local dev server, against the local R2 bucket
npm run sync         # build the library and publish it
npm run build        # build every workspace
npm run check-types  # typecheck every workspace
npm run preview      # build + run the Worker locally
npm run deploy       # build + deploy to Cloudflare Workers
npm test             # the test suite
npm run lint         # biome, across the repo
```

`npm run cf-typegen -w @bookshelf/app` regenerates `cloudflare-env.d.ts` after
you edit `wrangler.jsonc`.

## Documentation

Published at <https://murerkinn.github.io/bookshelf/>.

| | |
| --- | --- |
| [Publishing a library](docs/publishing.md) | the sync tool, its flags, and covers |
| [The library format](docs/library-format.md) | what ends up in storage, and what to back up |
| [Storage providers](docs/providers/README.md) | choosing where your library lives |
| [Cloudflare R2](docs/providers/r2.md) | setup, deploying, publishing locally |
| [Filesystem](docs/providers/fs.md) | your own machine or a VPS |
| [Profiles](docs/profiles.md) | who is reading, and where they got to |
| [Reading in the browser](docs/reader.md) | the readers and their controls |
| [The OPDS catalog](docs/opds.md) | reading on a Kobo, a Kindle, or any OPDS client |
| [Architecture](docs/architecture.md) | for working on the code |
| [What's missing](docs/roadmap.md) | limitations, and what's planned |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: Node 24, `npm install`, and
`npm run lint`, `npm run check-types` and `npm test` before you push. Say what
you verified — the tests reach the packages and the app's service layer but not
its pages.

Storage providers are the extension point, and yours doesn't have to live here.
A package published by anyone can be installed and named in the config.

## License

MIT — see [LICENSE](LICENSE).

That covers the code in this repository. The app and the Docker image also ship
other people's, under their own terms, listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

None of it says anything about the books you put in a library built with it,
whose copyright is between you and their publishers.
