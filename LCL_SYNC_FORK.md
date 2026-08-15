# LCL//SYNC MoviPlayer Fork

This repository is the **engine distribution fork** used by LCL//SYNC. It retains the MoviPlayer 0.4.0 slim custom element and its `movi.wasm` companion so that the watch-party application can ship the engine from its own dependency graph rather than loading a third-party CDN at runtime.

## Scope

The slim element has the same player API and feature surface as the upstream custom element, including WebCodecs playback, MKV container handling, subtitles, multi-audio, chapters, playback controls, canvas rendering, and the documented custom-element events. The WASM binary is an engine artifact only; LCL//SYNC supplies the media URL separately as an opaque, room-scoped Worker range endpoint.

## Privacy boundary

This fork deliberately contains **no source URL, relay secret, viewer grant, or room state**. LCL//SYNC keeps upstream media URLs solely in ephemeral Durable Object memory and gives each browser only a short-lived opaque route. The package must never be configured with an upstream media URL in static source, package metadata, tests, or build output.

## Upstream and attribution

The fork is based on [MoviPlayer](https://github.com/MrUjjwalG/movi-player) commit `fc5ae6bdea103ebc866ada98baa23cabc8b6985f`, licensed under Apache-2.0. The retained `LICENSE` includes all required upstream and bundled-component notices. The fork modifies package identity and distribution scope; the upstream source tree remains available on the `upstream` remote for review and future merges.
