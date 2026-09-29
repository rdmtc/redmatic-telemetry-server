#!/bin/sh
# Builds the image and pushes it as :latest and :<package version>. Run by hand; needs `docker login`.
set -eu

IMAGE=${IMAGE:-hobbyquaker/redmatic-telemetry-server}
VERSION=$(node -p "require('./package.json').version")

docker buildx build --push \
    --tag "$IMAGE:latest" \
    --tag "$IMAGE:$VERSION" \
    "$@" .
