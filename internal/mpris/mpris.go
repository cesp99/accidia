// Package mpris exposes the app over D-Bus as an MPRIS v2 media player
// on Linux, so system media keys, the KDE/GNOME media widget, headset
// controls, and any other MPRIS client (playerctl, Waybar, etc.) can
// control playback even though the app's audio pipeline is Web Audio
// (which WebKit2GTK does not auto-bridge to MPRIS — it only bridges
// HTMLMediaElement playback).
//
// On non-Linux platforms a stub is compiled instead; the public API is
// the same so app.go doesn't need `runtime.GOOS` branches.
//
// MPRIS spec: https://specifications.freedesktop.org/mpris-spec/latest/
package mpris

// PlaybackStatus mirrors the MPRIS "org.mpris.MediaPlayer2.Player.PlaybackStatus"
// property. Use one of the constants below rather than a raw string so
// callers don't typo the capitalisation (the spec is case-sensitive).
type PlaybackStatus string

const (
	StatusPlaying PlaybackStatus = "Playing"
	StatusPaused  PlaybackStatus = "Paused"
	StatusStopped PlaybackStatus = "Stopped"
)

// Metadata is the subset of the MPRIS metadata map we care about.
// Fields we don't expose (genre, rating, trackNumber, etc.) are left
// off for simplicity — the system widgets only need what's here to
// render the now-playing card.
type Metadata struct {
	// Title/Artist/Album are the standard xesam:title / xesam:artist /
	// xesam:album fields.
	Title  string
	Artist string
	Album  string
	// ArtURL is the xesam:artUrl — an absolute file:// URL on disk or a
	// data: URI for embedded artwork. Widgets render this as the cover.
	ArtURL string
	// LengthSec is the track duration in seconds; converted to xesam's
	// microsecond int64 at the D-Bus boundary.
	LengthSec float64
	// TrackPath is the file path the metadata refers to — used to build
	// the unique MPRIS trackid so seek events emit correctly.
	TrackPath string
}

// Controller is what app.go calls. See linux.go / stub.go for the real
// implementations. The interface lets tests substitute a fake.
type Controller interface {
	// Start registers the D-Bus service and starts listening for
	// method calls. Safe to call more than once; subsequent calls are
	// no-ops.
	Start() error
	// Stop releases the D-Bus name and unregisters method handlers.
	Stop()
	// Running reports whether Start succeeded. Useful for tests +
	// diagnostics; the frontend doesn't need to know.
	Running() bool
	// Update<> setters push state into the MPRIS properties. They are
	// cheap; the setters emit PropertiesChanged signals only when the
	// value actually changes.
	UpdateMetadata(m Metadata)
	UpdatePlaybackStatus(s PlaybackStatus)
	UpdatePosition(sec float64)
	UpdateCanGoNext(v bool)
	UpdateCanGoPrevious(v bool)
}

// Handlers is the set of callbacks MPRIS invokes when the desktop sends
// us a control command (media keys, widget click, headset button).
// Pass these to New() when constructing the service.
type Handlers struct {
	OnPlay        func()
	OnPause       func()
	OnPlayPause   func()
	OnStop        func()
	OnNext        func()
	OnPrevious    func()
	OnSeek        func(offsetSec float64)    // relative seek from current position
	OnSetPosition func(positionSec float64)  // absolute seek to position
}
