# syntax=docker/dockerfile:1

# The floor this project declares in engines and .nvmrc.
ARG NODE_VERSION=22

# Dependencies first, from the manifests alone, so editing source does not
# invalidate the install layer.
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/bookshelf/package.json apps/bookshelf/
COPY packages/core/package.json packages/core/
COPY packages/provider-fs/package.json packages/provider-fs/
COPY packages/provider-r2/package.json packages/provider-r2/
COPY packages/sync/package.json packages/sync/
RUN npm ci

FROM deps AS build
COPY . .
# This image serves a directory, so it is built for the filesystem provider.
# next.config.ts reads this file at build time and bakes the answer into the
# bundle, which is why it has to be in place before the build rather than
# passed in when the container starts.
COPY docker/bookshelf.config.json ./bookshelf.config.json
RUN npm run build
# Turborepo, Biome, TypeScript and wrangler are build-time only. Pruning here
# rather than reinstalling in the next stage keeps one copy of the tree.
RUN npm prune --omit=dev

FROM node:${NODE_VERSION}-slim AS runtime

# cwebp thumbnails covers, pdftoppm renders a PDF's first page. Without them
# the sync tool degrades quietly — full-size covers, no covers for PDFs — so
# they belong in the image rather than in a list of things to remember.
RUN apt-get update \
  && apt-get install --no-install-recommends -y poppler-utils webp \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app
COPY --from=build /app ./

# /books is where books are read from, /library is the tree the sync tool
# builds, /data holds the published library and everything the app writes to
# it. Created and owned here so a named volume mounted at /data inherits an
# ownership the app can actually write to.
RUN mkdir -p /books /library /data/library \
  && chown -R node:node /books /library /data

USER node
EXPOSE 3000
VOLUME ["/data"]

# -H is explicit: the default binds the loopback inside the container, which
# is unreachable from outside it.
CMD ["npm", "run", "start", "-w", "@bookshelf/app", "--", "-H", "0.0.0.0"]
