# Odysseus Control Plane
#
# Only the Control Plane is containerised. The Gateway deliberately is not: it
# runs on the developer's own workstation, where the agent CLIs, the source
# checkout and the SSH keys live. Containerising it would mean the agent could
# not reach the code it is meant to edit.
#
# Build context is the `odysseus/` workspace root, because the Control Plane
# depends on sibling workspace packages (@odysseus/protocol, schemas, config,
# policy-engine, attention-engine) and pnpm needs the whole workspace to
# resolve `workspace:*` links.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build

# corepack pins pnpm to the version in package.json's packageManager field, so
# the container builds with the same resolver as the lockfile was written by.
RUN corepack enable

WORKDIR /app

COPY . .

# --frozen-lockfile makes a drifted lockfile fail the build rather than
# silently resolving different versions than were tested.
RUN pnpm install --frozen-lockfile

# Typecheck as part of the image build. A type error becomes a failed build
# instead of a container that starts and then crashes in production.
RUN pnpm exec tsc --build

# ----------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime

# Run as a non-root user. Nothing here needs root, and a compromised process
# should not be able to write to its own image.
RUN useradd --create-home --shell /bin/bash odysseus

WORKDIR /app

COPY --from=build --chown=odysseus:odysseus /app /app

USER odysseus

ENV NODE_ENV=production
# Hosted platforms inject PORT; 4000 is the fallback for a plain `docker run`.
ENV PORT=4000
ENV CONTROL_PLANE_HOST=0.0.0.0

EXPOSE 4000

# The Control Plane serves /health unauthenticated for exactly this purpose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run node directly, with tsx loaded in-process.
#
# Not through pnpm: corepack downloaded pnpm from npm on every container start
# (seen in the first Render deploy log), which slowed every cold start and made
# boot depend on the npm registry being reachable. pnpm also sat between the
# platform's SIGTERM and the server, which is what produced "Command failed with
# signal SIGTERM" instead of a graceful drain. As PID 1, node receives the
# signal itself and server.ts shuts down cleanly.
#
# tsx rather than compiled output: the workspace packages export ./src/index.ts,
# so plain `node dist/server.js` would resolve sibling packages back to
# TypeScript source and fail. tsx is a pinned dependency, not an npx fetch.
# See docs/DEPLOYMENT.md.
WORKDIR /app/control-plane
CMD ["node", "--import", "tsx", "src/server.ts"]
