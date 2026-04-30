//go:build linux

package mpris

import (
	"fmt"
	"sync"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"
)

// D-Bus names + object paths per MPRIS v2 spec.
const (
	busName       = "org.mpris.MediaPlayer2.accidia"
	objectPath    = "/org/mpris/MediaPlayer2"
	rootIface     = "org.mpris.MediaPlayer2"
	playerIface   = "org.mpris.MediaPlayer2.Player"
	trackIDPrefix = "/org/mpris/MediaPlayer2/accidia/track"
)

// New builds an MPRIS Controller for Linux. The returned object is
// idle until Start() is called.
func New(identity string, handlers Handlers) Controller {
	if identity == "" {
		identity = "Accidia"
	}
	return &service{
		identity: identity,
		handlers: handlers,
	}
}

type service struct {
	mu       sync.Mutex
	identity string
	handlers Handlers

	conn  *dbus.Conn
	props *prop.Properties

	// Last-known values so we only emit PropertiesChanged when the value
	// actually changed. Saves D-Bus traffic in the playback loop.
	lastStatus   PlaybackStatus
	lastMetadata map[string]dbus.Variant
	lastPosUS    int64
	lastCanNext  bool
	lastCanPrev  bool

	started bool
}

func (s *service) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// Start connects to the session bus, publishes the MPRIS object, and
// requests the well-known name. Any failure leaves the service in a
// "not running" state and logs via the error return — the rest of the
// app keeps working, just without MPRIS integration.
func (s *service) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return nil
	}

	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return fmt.Errorf("dbus connect: %w", err)
	}

	// Register method tables for the two MPRIS interfaces. Method names
	// are capitalised to match the D-Bus wire spec (godbus auto-lowers
	// the first letter from Go method names, so we implement methods
	// with the spec's capitalisation directly).
	if err := conn.Export(rootObject{svc: s}, objectPath, rootIface); err != nil {
		_ = conn.Close()
		return fmt.Errorf("export root: %w", err)
	}
	if err := conn.Export(playerObject{svc: s}, objectPath, playerIface); err != nil {
		_ = conn.Close()
		return fmt.Errorf("export player: %w", err)
	}

	// Property table — MPRIS clients read these via
	// org.freedesktop.DBus.Properties.Get/GetAll. The `prop` helper
	// wires PropertiesChanged signals for us automatically.
	s.lastStatus = StatusStopped
	s.lastMetadata = map[string]dbus.Variant{
		"mpris:trackid": dbus.MakeVariant(dbus.ObjectPath(trackIDPrefix + "/nothing")),
		"mpris:length":  dbus.MakeVariant(int64(0)),
	}
	propsSpec := map[string]map[string]*prop.Prop{
		rootIface: {
			"CanQuit":             {Value: false, Writable: false, Emit: prop.EmitTrue},
			"CanRaise":            {Value: false, Writable: false, Emit: prop.EmitTrue},
			"HasTrackList":        {Value: false, Writable: false, Emit: prop.EmitTrue},
			"Identity":            {Value: s.identity, Writable: false, Emit: prop.EmitTrue},
			"DesktopEntry":        {Value: "accidia", Writable: false, Emit: prop.EmitTrue},
			"SupportedUriSchemes": {Value: []string{}, Writable: false, Emit: prop.EmitTrue},
			"SupportedMimeTypes":  {Value: []string{}, Writable: false, Emit: prop.EmitTrue},
		},
		playerIface: {
			"PlaybackStatus": {Value: string(StatusStopped), Writable: false, Emit: prop.EmitTrue},
			"LoopStatus":     {Value: "None", Writable: true, Emit: prop.EmitTrue},
			"Rate":           {Value: 1.0, Writable: true, Emit: prop.EmitTrue},
			"Shuffle":        {Value: false, Writable: true, Emit: prop.EmitTrue},
			"Metadata":       {Value: s.lastMetadata, Writable: false, Emit: prop.EmitTrue},
			"Volume":         {Value: 1.0, Writable: true, Emit: prop.EmitTrue},
			"Position":       {Value: int64(0), Writable: false, Emit: prop.EmitFalse},
			"MinimumRate":    {Value: 1.0, Writable: false, Emit: prop.EmitTrue},
			"MaximumRate":    {Value: 1.0, Writable: false, Emit: prop.EmitTrue},
			"CanGoNext":      {Value: true, Writable: false, Emit: prop.EmitTrue},
			"CanGoPrevious":  {Value: true, Writable: false, Emit: prop.EmitTrue},
			"CanPlay":        {Value: true, Writable: false, Emit: prop.EmitTrue},
			"CanPause":       {Value: true, Writable: false, Emit: prop.EmitTrue},
			"CanSeek":        {Value: true, Writable: false, Emit: prop.EmitTrue},
			"CanControl":     {Value: true, Writable: false, Emit: prop.EmitTrue},
		},
	}
	props, err := prop.Export(conn, objectPath, propsSpec)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("export props: %w", err)
	}

	// Introspection so tools like d-feet / qdbus discover us properly.
	node := &introspect.Node{
		Name: objectPath,
		Interfaces: []introspect.Interface{
			introspect.IntrospectData,
			prop.IntrospectData,
			{Name: rootIface, Methods: introspect.Methods(rootObject{svc: s}),
				Properties: props.Introspection(rootIface)},
			{Name: playerIface, Methods: introspect.Methods(playerObject{svc: s}),
				Properties: props.Introspection(playerIface),
				Signals: []introspect.Signal{
					{Name: "Seeked", Args: []introspect.Arg{
						{Name: "Position", Type: "x", Direction: "out"},
					}},
				},
			},
		},
	}
	if err := conn.Export(
		introspect.NewIntrospectable(node),
		objectPath,
		"org.freedesktop.DBus.Introspectable",
	); err != nil {
		_ = conn.Close()
		return fmt.Errorf("export introspect: %w", err)
	}

	// Claim the well-known name. `ReplaceExisting` lets a fresh launch
	// take over from a zombie/older Accidia instance so the user doesn't
	// have to manually `kill` before restarting. `AllowReplacement` is
	// the courtesy-pair — another legitimate Accidia launched after us
	// becomes the primary owner instead. `DoNotQueue` avoids a silent
	// wait if both flags fail to grant primary ownership.
	reply, err := conn.RequestName(
		busName,
		dbus.NameFlagReplaceExisting|dbus.NameFlagAllowReplacement|dbus.NameFlagDoNotQueue,
	)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("request name: %w", err)
	}
	if reply != dbus.RequestNameReplyPrimaryOwner {
		// Still keep the connection so property reads work, but log.
		// The frontend can still use the Web Media Session API as a
		// fallback on platforms where that happens to bridge.
	}

	s.conn = conn
	s.props = props
	s.started = true
	return nil
}

// Stop releases the bus name and closes the connection. Idempotent.
func (s *service) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started {
		return
	}
	if s.conn != nil {
		_, _ = s.conn.ReleaseName(busName)
		_ = s.conn.Close()
	}
	s.conn = nil
	s.props = nil
	s.started = false
}

// --- Property setters ------------------------------------------------------
//
// Note: all MPRIS properties are declared `Writable: false` in propsSpec
// above, because external clients must not be able to SetProperty() on
// them (a random app shouldn't be able to lie about our playback
// status). That means we can't use `props.Set()` from inside the
// process either — it's the *same* entry point and it honours the
// Writable flag, returning ErrReadOnly. Using SetMust bypasses the
// writable check and still emits PropertiesChanged so clients see the
// update. Forgetting this was what originally left the system widget
// showing an empty "Stopped" player even while audio was playing.

func (s *service) UpdatePlaybackStatus(status PlaybackStatus) {
	s.mu.Lock()
	if !s.started || s.props == nil || s.lastStatus == status {
		s.mu.Unlock()
		return
	}
	s.lastStatus = status
	props := s.props
	s.mu.Unlock()
	props.SetMust(playerIface, "PlaybackStatus", string(status))
}

func (s *service) UpdateMetadata(m Metadata) {
	md := map[string]dbus.Variant{}
	// Track id needs to be a unique object path per track so clients
	// know it's a new song (the Seeked signal / widget refresh depend
	// on this).
	idSuffix := sanitiseObjectPath(m.TrackPath)
	if idSuffix == "" {
		idSuffix = "current"
	}
	md["mpris:trackid"] = dbus.MakeVariant(dbus.ObjectPath(trackIDPrefix + "/" + idSuffix))
	md["mpris:length"] = dbus.MakeVariant(int64(m.LengthSec * 1_000_000))
	if m.Title != "" {
		md["xesam:title"] = dbus.MakeVariant(m.Title)
	}
	if m.Artist != "" {
		md["xesam:artist"] = dbus.MakeVariant([]string{m.Artist})
	}
	if m.Album != "" {
		md["xesam:album"] = dbus.MakeVariant(m.Album)
	}
	if m.ArtURL != "" {
		md["mpris:artUrl"] = dbus.MakeVariant(m.ArtURL)
	}
	if m.TrackPath != "" {
		md["xesam:url"] = dbus.MakeVariant("file://" + m.TrackPath)
	}

	s.mu.Lock()
	if !s.started || s.props == nil {
		s.mu.Unlock()
		return
	}
	s.lastMetadata = md
	props := s.props
	s.mu.Unlock()
	props.SetMust(playerIface, "Metadata", md)
}

func (s *service) UpdatePosition(sec float64) {
	us := int64(sec * 1_000_000)
	s.mu.Lock()
	if !s.started || s.props == nil {
		s.mu.Unlock()
		return
	}
	// Position property isn't emitted via PropertiesChanged (per spec),
	// but widgets poll it — so just store it for when they do.
	s.lastPosUS = us
	props := s.props
	s.mu.Unlock()
	props.SetMust(playerIface, "Position", us)
}

func (s *service) UpdateCanGoNext(v bool) {
	s.mu.Lock()
	if !s.started || s.props == nil || s.lastCanNext == v {
		s.mu.Unlock()
		return
	}
	s.lastCanNext = v
	props := s.props
	s.mu.Unlock()
	props.SetMust(playerIface, "CanGoNext", v)
}

func (s *service) UpdateCanGoPrevious(v bool) {
	s.mu.Lock()
	if !s.started || s.props == nil || s.lastCanPrev == v {
		s.mu.Unlock()
		return
	}
	s.lastCanPrev = v
	props := s.props
	s.mu.Unlock()
	props.SetMust(playerIface, "CanGoPrevious", v)
}

// --- D-Bus method handlers -------------------------------------------------
//
// godbus dispatches incoming method calls to exported methods on these
// structs. Method names use PascalCase because that's what the MPRIS
// spec defines on the wire (D-Bus is case-sensitive).

type rootObject struct {
	svc *service
}

func (rootObject) Raise() *dbus.Error { return nil } // no-op; we don't support raising
func (rootObject) Quit() *dbus.Error  { return nil } // no-op; we don't allow remote quit

type playerObject struct {
	svc *service
}

func (p playerObject) Next() *dbus.Error {
	if cb := p.svc.handlers.OnNext; cb != nil {
		cb()
	}
	return nil
}

func (p playerObject) Previous() *dbus.Error {
	if cb := p.svc.handlers.OnPrevious; cb != nil {
		cb()
	}
	return nil
}

func (p playerObject) Pause() *dbus.Error {
	// No-op if already paused/stopped per the MPRIS spec.
	p.svc.mu.Lock()
	status := p.svc.lastStatus
	p.svc.mu.Unlock()
	if status != StatusPlaying {
		return nil
	}
	if cb := p.svc.handlers.OnPause; cb != nil {
		cb()
	}
	return nil
}

func (p playerObject) PlayPause() *dbus.Error {
	if cb := p.svc.handlers.OnPlayPause; cb != nil {
		cb()
		return nil
	}
	// Fallback: if the caller only registered OnPlay/OnPause, pick based
	// on our current status.
	p.svc.mu.Lock()
	status := p.svc.lastStatus
	p.svc.mu.Unlock()
	if status == StatusPlaying {
		if cb := p.svc.handlers.OnPause; cb != nil {
			cb()
		}
	} else {
		if cb := p.svc.handlers.OnPlay; cb != nil {
			cb()
		}
	}
	return nil
}

func (p playerObject) Stop() *dbus.Error {
	if cb := p.svc.handlers.OnStop; cb != nil {
		cb()
	}
	return nil
}

func (p playerObject) Play() *dbus.Error {
	// Per MPRIS spec: Play is a no-op if PlaybackStatus is already
	// "Playing". This matters because some desktops/media keys send
	// plain Play (not PlayPause) on every press, and our audio engine
	// would otherwise restart the source from its last playFrom offset,
	// audibly jumping back to the start of the song.
	p.svc.mu.Lock()
	status := p.svc.lastStatus
	p.svc.mu.Unlock()
	if status == StatusPlaying {
		return nil
	}
	if cb := p.svc.handlers.OnPlay; cb != nil {
		cb()
	}
	return nil
}

// Seek is a *relative* offset in microseconds.
func (p playerObject) Seek(offsetUS int64) *dbus.Error {
	if cb := p.svc.handlers.OnSeek; cb != nil {
		cb(float64(offsetUS) / 1_000_000)
	}
	return nil
}

// SetPosition is an *absolute* position in microseconds, scoped to a
// track id. We ignore the track id — our queue state is authoritative —
// but we honour the position.
func (p playerObject) SetPosition(_ dbus.ObjectPath, positionUS int64) *dbus.Error {
	if cb := p.svc.handlers.OnSetPosition; cb != nil {
		cb(float64(positionUS) / 1_000_000)
	}
	return nil
}

// OpenUri is in the spec but we don't support opening arbitrary URIs
// from other apps; return a "not supported" error so callers fall back
// to normal play/pause controls.
func (p playerObject) OpenUri(_ string) *dbus.Error {
	return dbus.NewError("org.mpris.MediaPlayer2.Player.Error.NotSupported", nil)
}

// sanitiseObjectPath turns a filesystem path into something usable as
// the tail of an object path (ASCII alphanumerics + underscore). We
// don't need the result to be reversible — it just needs to change
// whenever the track changes.
func sanitiseObjectPath(in string) string {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); i++ {
		c := in[i]
		switch {
		case c >= '0' && c <= '9', c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z':
			out = append(out, c)
		default:
			out = append(out, '_')
		}
	}
	// D-Bus paths have a hard 255-char limit per element; clamp.
	if len(out) > 128 {
		out = out[len(out)-128:]
	}
	return string(out)
}
