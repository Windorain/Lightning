# Build Guide

## Prerequisites

- Node.js 18+, npm
- Java 8 (for GTNH mod)
- buf CLI (`npm install -g @bufbuild/buf` or download from buf.build)

## Quick Start

    # Install web dependencies
    cd web && npm install && cd ..

    # Generate protocol code
    npm run protocol:gen

    # Build web (embed + workbench)
    npm run build:web

    # Build mod (GTNH)
    npm run build:mod:gtnh

## Development

    # Start web dev server
    npm run dev:web

    # Build everything
    npm run build:all
