package main

// Version is the single source of truth for the app version.
//
// Bump this one string when you cut a release. It is consumed by:
//   - GetHostInfo() — surfaced to the frontend (Settings → About)
//   - The macOS "About Accidia" menu (main.go)
//   - The Makefile `version` target (reads it with `go run`)
//
// Keep `wails.json` in sync manually — it controls installer / binary
// metadata (file properties on Windows, bundle version on macOS).
const Version = "0.1.0"
