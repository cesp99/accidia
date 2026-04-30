package main

import (
	"context"
	"fmt"
	"runtime"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/cesp99/infinite-jukebox/internal/collection"
	"github.com/cesp99/infinite-jukebox/internal/ffmpeg"
	"github.com/cesp99/infinite-jukebox/internal/health"
	"github.com/cesp99/infinite-jukebox/internal/library"
	"github.com/cesp99/infinite-jukebox/internal/lyrics"
	"github.com/cesp99/infinite-jukebox/internal/media"
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
	return &App{
		library:    library.New(st, ff, md),
		store:      st,
		lyrics:     lyrics.NewService(),
		ffmpeg:     ff,
		media:      md,
		collection: col,
	}
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
		Version:  "0.1.0",
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
