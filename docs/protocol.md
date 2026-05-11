# Data Protocols

Lightning uses two data formats defined in `protocol/lightning/v1/`:

## Plain (`plain.proto`)

Internal storage format. Full scene data including:
- Scene metadata (name, author, timestamps)
- World frames (block instances, entities)
- Block palette (block states ↔ IDs)
- Material library (textures, blend modes)

## Envelope (`envelope.proto`)

Network transport format:
- Metadata envelope (scene ID, hash, sizes)
- Gzip-compressed binary payload (Plain serialized to JSON → deflate)

## Code Generation

    cd protocol && buf generate

Outputs:
- Java classes → `mod/*/src/main/java/com/lightning/proto/v1/`
- TypeScript types → `web/src/render/proto/`
