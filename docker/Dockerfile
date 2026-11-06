# Build from the repository root:
#   docker build -f docker/Dockerfile -t tend .

FROM node:26-slim AS build
WORKDIR /repo
RUN npm install --global --ignore-scripts pnpm@12.14.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN mkdir /pack && cd packages/tendcms && npm pack --pack-destination /pack

# The final image installs the packed package, the same way a person's npm install
# does, so it proves what's published works. Native modules ship prebuilt, so no
# install scripts run.
FROM node:26-slim
ENV NODE_ENV=production \
    TEND_DATA_DIR=/data \
    TEND_PLATFORM=docker \
    PATH=/opt/tend/node_modules/.bin:$PATH
WORKDIR /opt/tend
COPY --from=build /pack/ /tmp/pack/
RUN npm init --yes >/dev/null \
    && npm install --omit=dev --ignore-scripts /tmp/pack/tendcms-*.tgz \
    && rm -rf /tmp/pack
# Before VOLUME, so a new named volume starts out owned by the node user.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["tendcms", "start"]
