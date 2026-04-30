package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/cesp99/infinite-jukebox/internal/collection"
	"github.com/cesp99/infinite-jukebox/internal/ffmpeg"
	"github.com/cesp99/infinite-jukebox/internal/health"
	"github.com/cesp99/infinite-jukebox/internal/library"
	"github.com/cesp99/infinite-jukebox/internal/lyrics"
	"github.com/cesp99/infinite-jukebox/internal/media"
	"github.com/cesp99/infinite-jukebox/internal/mpris"
	"github.com/cesp99/infinite-jukebox/internal/store"
)

// App is the root struct exposed to the frontend through Wails bindings.
// All public methods on this type are auto-generated as TypeScript wrappers
// in `frontend/wailsjs/go/main/App.ts` at build time, and can be imported
// from React like `import { ScanLibrary } from '../wailsjs/go/main/App'`.
//
// The types returned by bound methods come from the internal/* packages,
// so the Wails binding generator produces matching TypeScript namespaces
// (e.g. `library`, `store`, `lyrics`). The frontend imports types from
// those namespaces.
type App struct {
	ctx        context.Context
	library    *library.Library
	store      *store.Store
	lyrics     *lyrics.Service
	ffmpeg     *ffmpeg.Service
	media      *media.Store
	collection *collection.Store
	mpris      mpris.Controller

	// Cached cover-art data URLs -> on-disk file paths, so MPRIS gets a
	// stable `file://` URL it can resolve instead of a multi-megabyte
	// data URL (which most MPRIS clients reject and which can push a
	// single D-Bus property-set over the bus's message-size limit,
	// silently dropping the entire metadata push).
	artCacheMu  sync.Mutex
	artCacheDir string
	artCache    map[string]string // sha1(dataURL prefix) -> absolute file path
}

// HostInfo is the small payload describing the host we're running on.
// Kept in `main` (rather than a subpackage) because it's only ever used
// as a one-off return value for the HostInfo bound method.
type HostInfo struct {
	Platform string `json:"platform"` // "darwin" | "linux" | "windows"
	Arch     string `json:"arch"`     // "amd64" | "arm64"
	Version  string `json:"version"`  // app semver
}

// NewApp creates a new App instance with all the heavy-lifting subsystems
// wired up. The Library reads tags + cover art from disk; the Store
// persists settings + the music index to the user-data directory.
func NewApp() *App {
	st := store.New()
	ff := ffmpeg.New()
	// 8 entries lets us comfortably keep current + preloaded-next + a
	// few recently-played tracks warm so hitting Back or jumping around
	// the queue doesn't force a re-decode.
	md := media.New(8)
	col := collection.New()
	app := &App{
		library:    library.New(st, ff, md),
		store:      st,
		lyrics:     lyrics.NewService(),
		ffmpeg:     ff,
		media:      md,
		collection: col,
		artCache:   map[string]string{},
	}
	// MPRIS needs access to the Wails event bus to forward desktop
	// control commands to the frontend. We assemble the Handlers now
	// (capturing `app` so the closures can reach `a.ctx`) but the
	// controller itself doesn't start until startup().
	app.mpris = mpris.New("Accidia", mpris.Handlers{
		OnPlay:        func() { app.emitMPRIS("play") },
		OnPause:       func() { app.emitMPRIS("pause") },
		OnPlayPause:   func() { app.emitMPRIS("playpause") },
		OnStop:        func() { app.emitMPRIS("stop") },
		OnNext:        func() { app.emitMPRIS("next") },
		OnPrevious:    func() { app.emitMPRIS("previous") },
		OnSeek:        func(offset float64) { app.emitMPRIS("seek", offset) },
		OnSetPosition: func(position float64) { app.emitMPRIS("setposition", position) },
	})
	return app
}

// emitMPRIS forwards a desktop media command to the frontend. Called
// from D-Bus method handlers that may run on background goroutines —
// runtime.EventsEmit is goroutine-safe so the dispatch is fine.
func (a *App) emitMPRIS(event string, args ...any) {
	if a.ctx == nil {
		return
	}
	wruntime.LogInfof(a.ctx, "mpris: command received: %s", event)
	wruntime.EventsEmit(a.ctx, "mpris:"+event, args...)
}

// Media returns the underlying MediaStore so main.go can wire it into the
// AssetServer handler. Kept as a method rather than a package-level global
// so tests can swap the store.
func (a *App) Media() *media.Store { return a.media }

// startup is called by Wails once the underlying window has been created
// but before the JS bridge is fully ready. We stash the context so we can
// emit events back to the frontend later.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if err := a.store.Init(); err != nil {
		wruntime.LogErrorf(ctx, "store init: %v", err)
	}
	if err := a.collection.Init(); err != nil {
		wruntime.LogErrorf(ctx, "collection init: %v", err)
	}
	if err := a.mpris.Start(); err != nil {
		// Non-fatal — the app still works without desktop media
		// integration, just without media-key support on Linux.
		wruntime.LogWarningf(ctx, "mpris: %v (media keys won't control this app)", err)
	} else if a.mpris.Running() {
		wruntime.LogInfo(ctx, "mpris: registered on org.mpris.MediaPlayer2.accidia")
	}
	a.library.AttachContext(ctx)
}

// domReady runs once the frontend has finished hydrating and the JS
// bindings are usable. Useful for pre-pushing cached state.
func (a *App) domReady(ctx context.Context) {
	wruntime.LogInfo(ctx, "Frontend ready")
}

// beforeClose lets us veto a window close (e.g. for "Save before quit?").
// Returning true cancels the close.
func (a *App) beforeClose(ctx context.Context) bool {
	return false
}

// shutdown runs after the window has closed, before the process exits.
func (a *App) shutdown(ctx context.Context) {
	a.mpris.Stop()
	if err := a.store.Flush(); err != nil {
		wruntime.LogErrorf(ctx, "store flush: %v", err)
	}
}

// -----------------------------------------------------------------------
// Window control (called by the custom titlebar in the frontend)
// -----------------------------------------------------------------------

// MinimizeWindow minimises the window via the host OS's native call.
func (a *App) MinimizeWindow() { wruntime.WindowMinimise(a.ctx) }

// ToggleMaximizeWindow toggles between maximised and normal.
func (a *App) ToggleMaximizeWindow() {
	if wruntime.WindowIsMaximised(a.ctx) {
		wruntime.WindowUnmaximise(a.ctx)
	} else {
		wruntime.WindowMaximise(a.ctx)
	}
}

// CloseWindow asks the OS to close the window. The shutdown hook will
// run afterwards to flush state.
func (a *App) CloseWindow() { wruntime.Quit(a.ctx) }

// IsMaximized lets the frontend keep its maximize/restore icon in sync.
func (a *App) IsMaximized() bool { return wruntime.WindowIsMaximised(a.ctx) }

// GetHostInfo gives the frontend a few flags it needs to render correctly,
// most importantly the platform so we can leave room for traffic lights
// on macOS and use Mica accents on Windows.
func (a *App) GetHostInfo() HostInfo {
	return HostInfo{
		Platform: runtime.GOOS,
		Arch:     runtime.GOARCH,
		Version:  Version,
	}
}

// RunHealthCheck inspects the current runtime for known gotchas that
// would otherwise surface as opaque "Decoding failed" style errors. The
// frontend renders the result as a startup banner if anything's wrong.
//
// Most commonly this catches Linux systems with gst-plugins-good missing,
// which breaks WebKit2GTK's Web Audio without any clear error in the UI.
func (a *App) RunHealthCheck() health.Check { return health.Run() }

// -----------------------------------------------------------------------
// Library bindings — these forward to library.go but expose a flat API to
// make the auto-generated TS wrappers simpler.
// -----------------------------------------------------------------------

// PickLibraryFolder shows a native folder picker and returns the chosen path.
// Empty string means the user cancelled.
func (a *App) PickLibraryFolder() (string, error) {
	path, err := wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "Choose your music folder",
	})
	if err != nil {
		return "", fmt.Errorf("open dialog: %w", err)
	}
	return path, nil
}

// PickAudioFile lets the user pick a single audio file ad-hoc (drag/drop
// is also supported by the frontend through the browser's File API).
func (a *App) PickAudioFile() (string, error) {
	path, err := wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "Choose an audio file",
		Filters: []wruntime.FileFilter{
			{DisplayName: "Audio", Pattern: "*.mp3;*.wav;*.flac;*.ogg;*.m4a;*.aac;*.opus"},
			{DisplayName: "All files", Pattern: "*.*"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("open dialog: %w", err)
	}
	return path, nil
}

// ScanLibrary recursively walks `path`, extracts audio metadata + cover
// art, and returns the resulting track list. The full index is also
// persisted via the Store so subsequent launches can restore instantly.
func (a *App) ScanLibrary(path string) (store.LibraryScanResult, error) {
	return a.library.Scan(path)
}

// GetLibrary returns the most recently scanned library from disk cache.
func (a *App) GetLibrary() (store.LibraryScanResult, error) {
	return a.library.Cached()
}

// GetTrackBytes reads the underlying audio file and returns its raw bytes
// so the frontend can decode it via Web Audio API. Prefer DecodeTrack for
// playback — this path is only useful if the frontend wants to hold the
// original compressed bytes for some reason.
func (a *App) GetTrackBytes(path string) (library.TrackPayload, error) {
	return a.library.LoadTrack(path)
}

// DecodeTrack decodes any supported audio file to interleaved int16 PCM
// that the frontend pairs with the asset-server MediaStore URL.
func (a *App) DecodeTrack(path string) (library.DecodedAudio, error) {
	return a.library.DecodeTrack(path)
}

// GetCoverArt returns the embedded cover art for a track as a data URL.
// Returns an empty string if no art is available.
func (a *App) GetCoverArt(path string) (string, error) {
	return a.library.LoadCoverArt(path)
}

// -----------------------------------------------------------------------
// Settings — small JSON blob persisted in the user's app data directory.
// -----------------------------------------------------------------------

// LoadSettings returns whatever settings the user previously persisted.
func (a *App) LoadSettings() (store.Settings, error) { return a.store.Settings(), nil }

// SaveSettings persists the given settings.
func (a *App) SaveSettings(s store.Settings) error { return a.store.SaveSettings(s) }

// -----------------------------------------------------------------------
// Lyrics — fetched from LRCLIB (free, CC0). See internal/lyrics.
// -----------------------------------------------------------------------

// FetchLyrics tries to resolve time-synced lyrics for a track. Returns an
// empty Lyrics{} (not an error) if the track isn't in the database, so
// callers can cheaply display a "no lyrics" state.
func (a *App) FetchLyrics(title, artist, album string, duration float64) (lyrics.Lyrics, error) {
	return a.lyrics.Get(a.ctx, title, artist, album, duration)
}

// -----------------------------------------------------------------------
// FFmpeg — lazy-downloaded sidecar for the long-tail audio codecs.
// -----------------------------------------------------------------------

// FFmpegStatus reports whether a usable ffmpeg is installed (either from
// the system or from our cache). The frontend uses this to decide whether
// to surface the download button.
func (a *App) FFmpegStatus() ffmpeg.Status { return a.ffmpeg.GetStatus() }

// InstallFFmpeg downloads a static ffmpeg build into the user's cache
// directory. Progress events are emitted on the `ffmpeg:progress` channel
// as `{stage, got, total}`. Returns the resolved binary path on success.
func (a *App) InstallFFmpeg() (string, error) {
	progress := func(got, total int64, stage string) {
		if a.ctx == nil {
			return
		}
		wruntime.EventsEmit(a.ctx, "ffmpeg:progress", map[string]any{
			"stage": stage,
			"got":   got,
			"total": total,
		})
	}
	return a.ffmpeg.EnsureAvailable(a.ctx, progress)
}

// -----------------------------------------------------------------------
// Favorites — persisted per-user in collection.json.
// -----------------------------------------------------------------------

// GetFavorites returns the track paths the user has favorited, newest first.
func (a *App) GetFavorites() []string { return a.collection.GetFavorites() }

// IsFavorite reports whether a specific track path is in favorites.
func (a *App) IsFavorite(path string) bool { return a.collection.IsFavorite(path) }

// SetFavorite adds or removes a track from favorites. Returns the new state.
func (a *App) SetFavorite(path string, favorite bool) (bool, error) {
	return a.collection.SetFavorite(path, favorite)
}

// ToggleFavorite flips the favorite state for the given path. Returns the new state.
func (a *App) ToggleFavorite(path string) (bool, error) {
	return a.collection.ToggleFavorite(path)
}

// -----------------------------------------------------------------------
// Playlists — ordered collections of track paths.
// -----------------------------------------------------------------------

// GetPlaylists returns all playlists, most-recently-updated first.
func (a *App) GetPlaylists() []collection.Playlist { return a.collection.GetPlaylists() }

// GetPlaylist returns a single playlist by ID.
func (a *App) GetPlaylist(id string) (collection.Playlist, error) {
	return a.collection.GetPlaylist(id)
}

// CreatePlaylist creates a new empty playlist.
func (a *App) CreatePlaylist(name, description string) (collection.Playlist, error) {
	return a.collection.CreatePlaylist(name, description)
}

// DeletePlaylist deletes a playlist by ID.
func (a *App) DeletePlaylist(id string) error { return a.collection.DeletePlaylist(id) }

// RenamePlaylist updates the playlist name + description.
func (a *App) RenamePlaylist(id, name, description string) (collection.Playlist, error) {
	return a.collection.RenamePlaylist(id, name, description)
}

// AddToPlaylist appends tracks to the playlist (skipping dupes).
func (a *App) AddToPlaylist(id string, paths []string) (collection.Playlist, error) {
	return a.collection.AddToPlaylist(id, paths)
}

// RemoveFromPlaylist removes tracks from a playlist.
func (a *App) RemoveFromPlaylist(id string, paths []string) (collection.Playlist, error) {
	return a.collection.RemoveFromPlaylist(id, paths)
}

// ReorderPlaylist rewrites the playlist order from the given path list.
func (a *App) ReorderPlaylist(id string, paths []string) (collection.Playlist, error) {
	return a.collection.ReorderPlaylist(id, paths)
}

// -----------------------------------------------------------------------
// Prefetch — warm up the next track's decoded PCM so switching is instant.
// -----------------------------------------------------------------------

// PrefetchTrack decodes a track and registers its PCM in the MediaStore
// without any immediate playback intent. This is called by the frontend
// after a track starts playing, for the next track in the queue, so that
// by the time the user hits Next (or the track ends) the PCM is already
// warm and the UI transition is effectively instant.
func (a *App) PrefetchTrack(path string) (library.DecodedAudio, error) {
	return a.library.DecodeTrack(path)
}

// -----------------------------------------------------------------------
// MPRIS bridge — lets the frontend push now-playing state to Linux's
// desktop media integration. No-op on macOS/Windows where the browser's
// MediaSession API already bridges to SMTC / Now Playing. Calling the
// Update methods on any platform is cheap and safe; we treat the
// off-platform case as "controller is always a stub".
// -----------------------------------------------------------------------

// MprisUpdateMetadata tells the system media widget what's now playing.
// `duration` is in seconds. `artURL` may be a data URL, a file:// URL,
// an http(s):// URL, or empty. Data URLs get cached to disk and
// replaced with a file:// URL because (a) most MPRIS clients only
// understand resolvable URLs, and (b) stuffing a multi-MB base64 blob
// into the Metadata property can exceed the D-Bus message-size cap
// and cause the whole property-set to be dropped — which is what was
// leaving the system widget empty even though the app was playing.
func (a *App) MprisUpdateMetadata(title, artist, album, artURL, trackPath string, duration float64) {
	resolvedArt := a.resolveArtURL(artURL, trackPath)
	if a.ctx != nil {
		wruntime.LogInfof(a.ctx, "mpris: metadata title=%q artist=%q album=%q dur=%.1fs art=%s",
			title, artist, album, duration, shortArt(resolvedArt))
	}
	a.mpris.UpdateMetadata(mpris.Metadata{
		Title:     title,
		Artist:    artist,
		Album:     album,
		ArtURL:    resolvedArt,
		LengthSec: duration,
		TrackPath: trackPath,
	})
}

// resolveArtURL turns whatever the frontend passed into an artURL MPRIS
// can work with. Returns "" to mean "no art" — the MPRIS package omits
// the field entirely in that case.
func (a *App) resolveArtURL(artURL, trackPath string) string {
	if artURL == "" {
		return ""
	}
	if strings.HasPrefix(artURL, "file://") ||
		strings.HasPrefix(artURL, "http://") ||
		strings.HasPrefix(artURL, "https://") {
		return artURL
	}
	if !strings.HasPrefix(artURL, "data:") {
		// Unknown scheme; safer to skip than to break the metadata.
		return ""
	}
	key := mpris.ArtCacheKey(trackPath, artURL)

	a.artCacheMu.Lock()
	if p, ok := a.artCache[key]; ok {
		a.artCacheMu.Unlock()
		// Double-check the file is still around — a restart deletes the
		// cache dir, and a stale map entry would hand MPRIS a file:// URL
		// it can't resolve.
		if _, err := os.Stat(p); err == nil {
			return "file://" + p
		}
		// File's gone; fall through to rewrite.
		a.artCacheMu.Lock()
		delete(a.artCache, key)
	}
	dir := a.artCacheDir
	a.artCacheMu.Unlock()

	if dir == "" {
		d, err := store.UserConfigDir("Accidia")
		if err != nil {
			return ""
		}
		dir = filepath.Join(d, "mpris-art")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return ""
		}
		a.artCacheMu.Lock()
		a.artCacheDir = dir
		a.artCacheMu.Unlock()
	}

	filePath, ok := mpris.WriteDataURLToCache(artURL, dir, key)
	if !ok {
		return ""
	}
	a.artCacheMu.Lock()
	a.artCache[key] = filePath
	a.artCacheMu.Unlock()
	return "file://" + filePath
}

// shortArt truncates URLs so debug logs don't contain megabytes of base64.
func shortArt(u string) string {
	if len(u) <= 80 {
		return u
	}
	return u[:77] + "..."
}

// MprisUpdatePlaybackStatus accepts one of "Playing", "Paused", "Stopped".
// Any other value is treated as "Stopped".
func (a *App) MprisUpdatePlaybackStatus(status string) {
	var s mpris.PlaybackStatus
	switch status {
	case "Playing":
		s = mpris.StatusPlaying
	case "Paused":
		s = mpris.StatusPaused
	default:
		s = mpris.StatusStopped
	}
	if a.ctx != nil {
		wruntime.LogInfof(a.ctx, "mpris: status %s", s)
	}
	a.mpris.UpdatePlaybackStatus(s)
}

// MprisUpdatePosition syncs the scrubber position in the desktop
// widget. `position` is in seconds.
func (a *App) MprisUpdatePosition(position float64) {
	a.mpris.UpdatePosition(position)
}

// MprisUpdateCapabilities lets the frontend report whether Next/Prev
// are enabled right now (empty queue disables them, for example). The
// desktop widget greys out the corresponding buttons when these are
// false.
func (a *App) MprisUpdateCapabilities(canNext, canPrevious bool) {
	a.mpris.UpdateCanGoNext(canNext)
	a.mpris.UpdateCanGoPrevious(canPrevious)
}
