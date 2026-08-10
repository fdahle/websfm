FROM node:22-alpine AS build

WORKDIR /app

# Where the app is mounted on the host (must start and end with "/"), and where
# the four .onnx weights are served from. Leave VITE_MODEL_BASE_URL empty to
# bundle public/models/*.onnx into the image instead.
ARG VITE_BASE_PATH=/
ARG VITE_MODEL_BASE_URL=
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_MODEL_BASE_URL=$VITE_MODEL_BASE_URL

COPY package.json package-lock.json ./
RUN npm ci

# .dockerignore keeps the host node_modules out, so the npm ci layer above
# survives this copy. Without it the linux/musl install is overwritten by the
# build host's platform-specific esbuild/rollup binaries.
COPY . .

# Opt in with --build-arg RUN_RELEASE_CHECK=1 to also run
# scripts/check-release.mjs, which verifies the artifact is actually deployable
# (LICENSE, favicon, the ORT runtime, and — unless VITE_MODEL_BASE_URL is set —
# the four bundled model weights). It is off by default because the weights are
# gitignored: a fresh clone has no public/models/*.onnx and would fail the check.
ARG RUN_RELEASE_CHECK=0
RUN npm run build \
 && if [ "$RUN_RELEASE_CHECK" = "1" ]; then npm run check:release; fi

FROM nginx:alpine

# The stock config serves .mjs as application/octet-stream (ONNX Runtime then
# fails to import its wasm loader) and sends no COOP/COEP, which silently drops
# ONNX to a single thread. See deploy/nginx.conf.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
