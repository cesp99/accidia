//go:build linux

package main

import "os"

// init runs before main() and before any GTK/WebKit code in the Wails
// runtime touches the GDK display. We use it to pin the GDK backend
// to X11 (XWayland on Wayland sessions) so frameless windows behave
// consistently across compositors.
//
// Why: with GDK_BACKEND=wayland, GTK3 frameless windows on KDE /
// GNOME / Hyprland / etc. still acquire a server-side decoration bar
// because the Wayland CSD vs SSD negotiation falls back to "show
// something" when the app says "I'll draw my own chrome". The result
// is a double titlebar — the OS's frame above our app's custom
// titlebar — which looks broken (see app.go's TitleBar component).
//
// Forcing GDK_BACKEND=x11 routes us through XWayland on Wayland
// systems, which honours `Frameless: true` from main.go cleanly.
// Pure-X11 sessions don't even notice this var, so it's a no-op
// there. We only set it when the user hasn't already pinned the
// backend themselves; respecting an explicit GDK_BACKEND=wayland
// is important for power users who actually want the native CSD.
func init() {
	if os.Getenv("GDK_BACKEND") != "" {
		return
	}
	os.Setenv("GDK_BACKEND", "x11")
}
