//go:build linux

package mpris_test

import (
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/mpris"
	"github.com/godbus/dbus/v5"
)

// TestLinuxService_UpdatesProperties verifies that the Linux MPRIS
// service actually mutates PlaybackStatus and Metadata after
// UpdatePlaybackStatus / UpdateMetadata are called, as observed via
// a plain D-Bus GetAll from a separate connection.
//
// This is a regression test for the "properties stuck on their initial
// values" bug: MPRIS props are declared Writable=false, which means
// godbus' `Properties.Set()` refused our internal updates with
// ErrReadOnly — we have to use SetMust. If that ever reverts, this
// test fails.
//
// The test registers the service under a different bus name so it
// doesn't collide with a real running Accidia instance.
func TestLinuxService_UpdatesProperties(t *testing.T) {
	// Skip if no session bus is available (CI, headless build servers).
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Skipf("no session bus available: %v", err)
	}
	defer conn.Close()

	handlers := mpris.Handlers{}
	ctrl := mpris.New("AccidiaTest", handlers)
	if err := ctrl.Start(); err != nil {
		t.Fatalf("mpris.Start: %v", err)
	}
	defer ctrl.Stop()

	if !ctrl.Running() {
		t.Fatal("controller reported not running after Start")
	}

	// Push a new state.
	ctrl.UpdatePlaybackStatus(mpris.StatusPlaying)
	ctrl.UpdateMetadata(mpris.Metadata{
		Title:     "Test Title",
		Artist:    "Test Artist",
		Album:     "Test Album",
		LengthSec: 123.4,
		TrackPath: "/music/test.mp3",
	})

	// Read it back via the public D-Bus API (this is what any
	// desktop widget would do).
	obj := conn.Object("org.mpris.MediaPlayer2.accidia", "/org/mpris/MediaPlayer2")
	var all map[string]dbus.Variant
	if err := obj.Call(
		"org.freedesktop.DBus.Properties.GetAll", 0,
		"org.mpris.MediaPlayer2.Player",
	).Store(&all); err != nil {
		t.Fatalf("GetAll: %v", err)
	}

	statusVar, ok := all["PlaybackStatus"]
	if !ok {
		t.Fatal("PlaybackStatus not in GetAll result")
	}
	if got, _ := statusVar.Value().(string); got != "Playing" {
		t.Errorf("PlaybackStatus = %q; want \"Playing\"", got)
	}

	mdVar, ok := all["Metadata"]
	if !ok {
		t.Fatal("Metadata not in GetAll result")
	}
	md, ok := mdVar.Value().(map[string]dbus.Variant)
	if !ok {
		t.Fatalf("Metadata is %T; want map[string]dbus.Variant", mdVar.Value())
	}
	if title, _ := md["xesam:title"].Value().(string); title != "Test Title" {
		t.Errorf("xesam:title = %q; want \"Test Title\"", title)
	}
	artistList, _ := md["xesam:artist"].Value().([]string)
	if len(artistList) != 1 || artistList[0] != "Test Artist" {
		t.Errorf("xesam:artist = %v; want [\"Test Artist\"]", artistList)
	}
	if length, _ := md["mpris:length"].Value().(int64); length != 123_400_000 {
		t.Errorf("mpris:length = %d; want 123400000 (123.4s in µs)", length)
	}
}
