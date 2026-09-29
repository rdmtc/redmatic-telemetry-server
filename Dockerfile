# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
# The country database is not in the repository: mounted at /geo (scripts/update-dbip.sh), or baked in when the
# build context has it.
COPY . /tmp/context
RUN mkdir -p /geo && (cp /tmp/context/dbip-country-lite.csv.gz /geo/ 2>/dev/null || true)

FROM node:24-slim
# the uid/gid the host's volumes belong to
ARG UID=996
# DB_PATH is not set here: the old DB variable keeps working, and without either the database is
# /usr/src/app/redmatic.db, as before.
ENV NODE_ENV=production \
    PORT=8080 \
    DBIP_CSV=/geo/dbip-country-lite.csv.gz
RUN groupmod -g "$UID" node && usermod -u "$UID" -g "$UID" node \
    && mkdir -p /data && chown node:node /data
COPY --from=deps /geo /geo
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY package.json server.js ./
COPY data ./data
COPY lib ./lib
COPY schema ./schema
COPY www ./www
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
