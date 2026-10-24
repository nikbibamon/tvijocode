#!/usr/bin/env bash
# Install the pinned, checksum-verified mcp-publisher into the given directory.
# Pinned to v1.8.1 (2026-08-06): the registry shipped three releases on
# 2026-10-23, so we wait for those to settle before moving.

set -euo pipefail

DEST="${1:?usage: mcp_publisher.sh <dir>}"
VERSION="v1.8.1"
SHA256="a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc"
URL="https://github.com/modelcontextprotocol/registry/releases/download/${VERSION}/mcp-publisher_linux_amd64.tar.gz"

curl -fsSL --retry 3 -o "${DEST}/mcp-publisher.tgz" "${URL}"
echo "${SHA256}  ${DEST}/mcp-publisher.tgz" | sha256sum -c -
tar -xzf "${DEST}/mcp-publisher.tgz" -C "${DEST}" mcp-publisher
rm -f "${DEST}/mcp-publisher.tgz"
"${DEST}/mcp-publisher" --version
