# brink-server image. Build context: the repository root (like the root
# Dockerfile), because the server imports the bundled OpenTakeoff MCP core
# from mcp/dist and the Brink parts tools from brink-merge/.
#
#   docker build -f brink-server/Dockerfile -t brink-server .
#   docker run --rm -p 8080:8080 --env-file brink.env -v brink-data:/data brink-server

# ---- build: bundle the OpenTakeoff MCP core (mcp/dist/server-core.js) --------
FROM node:24-bookworm-slim AS mcp-build
WORKDIR /app
COPY . .
WORKDIR /app/mcp
# `npm run build` minus its two freshness checks (check:protocol-resources,
# check:wiki): they read docs/, which the root .dockerignore leaves out of the
# context, and CI runs them anyway. The bundle step itself is identical.
RUN npm ci \
 && npx esbuild server.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/server-core.js \
 && node scripts/finish-build.mjs

# ---- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app

# OpenTakeoff MCP core: the bundle plus its runtime packages (bundled with
# --packages=external, so they resolve from mcp/node_modules).
COPY --from=mcp-build /app/mcp/package.json /app/mcp/package-lock.json mcp/
RUN cd mcp && npm ci --omit=dev && npm cache clean --force
COPY --from=mcp-build /app/mcp/dist mcp/dist

# Brink parts list / schematic tools (TypeScript run through tsx).
COPY brink-merge/package.json brink-merge/package-lock.json brink-merge/
RUN cd brink-merge && npm ci --omit=dev && npm cache clean --force
COPY brink-merge/src brink-merge/src
COPY brink-merge/bin brink-merge/bin
COPY brink-merge/data brink-merge/data
COPY brink-merge/supabase brink-merge/supabase

# The server itself.
COPY brink-server/package.json brink-server/package-lock.json brink-server/
RUN cd brink-server && npm ci --omit=dev && npm cache clean --force
COPY brink-server/src brink-server/src
COPY brink-server/public brink-server/public
COPY brink-server/scripts brink-server/scripts

RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
WORKDIR /app/brink-server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npm", "start"]
