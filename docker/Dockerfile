# Build from the repository root:
#   docker build -f docker/Dockerfile -t tend .
#
# A release's image has the package that's on npm in it, put in pack/ first, rather than one
# made here (.github/workflows/docker.yml):
#   docker build -f docker/Dockerfile --build-arg PACKAGE=published -t tend .
ARG PACKAGE=built

FROM node:26-slim AS built
WORKDIR /repo
RUN npm install --global --ignore-scripts pnpm@12.14.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# The same shrinkwrap as the npm package (PLAN.md §12), so the image and npm install the
# same versions of everything.
RUN node scripts/shrinkwrap.mjs
RUN mkdir /pack && cd packages/tendcms && npm pack --pack-destination /pack

FROM scratch AS published
COPY pack/ /pack/

FROM ${PACKAGE} AS package

# The final image installs the packed package, the same way a person's npm install
# does, so it proves what's published works. Native modules ship prebuilt, so no
# install scripts run.
FROM node:26-slim
ENV NODE_ENV=production \
    TEND_DATA_DIR=/data \
    TEND_PLATFORM=docker \
    PATH=/opt/tend/node_modules/.bin:$PATH
WORKDIR /opt/tend
# Security fixes Debian has published since the base image was made. CI's Trivy scan
# fails on any it could have had.
RUN apt-get update \
    && apt-get upgrade --yes --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
COPY --from=package /pack/ /tmp/pack/
# npm installs Tend here and then goes: nothing needs it to run Tend, and what isn't in
# the image can't have a vulnerability.
RUN npm init --yes >/dev/null \
    && npm install --omit=dev --ignore-scripts /tmp/pack/tendcms-*.tgz \
    && rm -rf /tmp/pack /root/.npm \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# Before VOLUME, so a new named volume starts out owned by the node user (1000). A
# folder from the server, or a volume a host makes, can belong to root instead: Tend
# then says what to do, and on Railway it runs as root (RAILWAY_RUN_UID=0).
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["tendcms", "start"]
