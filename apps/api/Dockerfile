# The Nova API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t nova-api .
# Configuration is environment only (see apps/api/.env.example); no secret is baked into the image.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

# Only the API and the packages it runs: the extension and the site are not installed.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/agent/package.json packages/agent/
COPY packages/core/package.json packages/core/
COPY packages/planner/package.json packages/planner/
COPY packages/protocol/package.json packages/protocol/
# tsx runs the TypeScript sources and is a dev dependency of the API, so dev dependencies are kept.
RUN npm ci --include=dev --workspace @nova-agent/api --workspace @nova-agent/agent --workspace @nova-agent/core --workspace @nova-agent/planner --workspace @nova-agent/protocol

COPY tsconfig.base.json ./
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/
COPY packages/agent packages/agent
COPY packages/core packages/core
COPY packages/planner packages/planner
COPY packages/protocol packages/protocol

# A container is reached from outside it. validateDeployment refuses to start on this address unless
# AUTH_MODE=google (students sign in) or NOVA_DEV_TOKEN is set.
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
USER node
CMD ["npm", "run", "start", "--workspace", "@nova-agent/api"]
