# Lightning Architecture

## Overview

Lightning is a Minecraft structure data replay platform with three major components:

- **mod/** — Minecraft mod that captures block models and exports structure data
- **web/** — Web frontend for viewing and editing structure data (EmbedViewer + Workbench)
- **protocol/** — Data format definitions (protobuf), single source of truth for mod ↔ web

## Data Flow

    Game World → mod captures mesh/structure → Plain format
                                                  ↓
                                       Envelope (compress)
                                                  ↓
                                       Upload to server
                                                  ↓
                                  Web Workbench loads → 3D View
