// Package collection persists the user's favorites list and playlists to
// a single JSON file in the app data directory. Track membership is by
// absolute file path; stale paths (moved/deleted files) are silently
// filtered out at render time by the frontend.
package collection

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cesp99/infinite-jukebox/internal/store"
)

// Playlist is a user-created ordered collection of track paths.
type Playlist struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
	// Paths stores track paths in playlist order. We don't embed full
	// Track structs — the frontend joins against the library at render
	// time so edits to tags are always reflected.
	Paths []string `json:"paths"`
}

// Data is what we persist. A single struct keeps the file layout easy
// to evolve later (e.g. adding smart playlists).
type Data struct {
	Favorites []string   `json:"favorites"`
	Playlists []Playlist `json:"playlists"`
}

// Store is a disk-backed store for favorites + playlists. Safe for
// concurrent use from Wails bound methods.
type Store struct {
	mu   sync.RWMutex
	path string
	data Data
}

// New returns an uninitialised store. Call Init() before using it —
// tests can pass an explicit path, production code uses the default in
// the user's app data dir.
func New() *Store {
	return &Store{
		data: Data{Favorites: []string{}, Playlists: []Playlist{}},
	}
}

// Init resolves the on-disk path and loads any existing data.
func (c *Store) Init() error {
	base, err := store.UserConfigDir("Accidia")
	if err != nil {
		return fmt.Errorf("user config dir: %w", err)
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", base, err)
	}
	c.mu.Lock()
	c.path = filepath.Join(base, "collection.json")
	c.mu.Unlock()
	return c.load()
}

// InitWithPath is used by tests to pin the file location.
func (c *Store) InitWithPath(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	c.mu.Lock()
	c.path = path
	c.mu.Unlock()
	return c.load()
}

// load reads the collection file if it exists. Missing file → empty data.
func (c *Store) load() error {
	c.mu.RLock()
	path := c.path
	c.mu.RUnlock()
	if path == "" {
		return errors.New("collection store not initialised")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	var loaded Data
	if err := json.Unmarshal(data, &loaded); err != nil {
		return fmt.Errorf("parse collection: %w", err)
	}
	if loaded.Favorites == nil {
		loaded.Favorites = []string{}
	}
	if loaded.Playlists == nil {
		loaded.Playlists = []Playlist{}
	}
	c.mu.Lock()
	c.data = loaded
	c.mu.Unlock()
	return nil
}

// saveLocked writes the current state to disk. Caller must hold the write lock.
func (c *Store) saveLocked() error {
	if c.path == "" {
		return errors.New("collection store not initialised")
	}
	data, err := json.MarshalIndent(c.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// -----------------------------------------------------------------------
// Favorites
// -----------------------------------------------------------------------

// GetFavorites returns the current list of favorite track paths, newest-first
// (we prepend on add, so the natural order is most-recently-favorited first).
func (c *Store) GetFavorites() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	// Return a copy so callers can't mutate our backing slice.
	out := make([]string, len(c.data.Favorites))
	copy(out, c.data.Favorites)
	return out
}

// IsFavorite reports whether a path is currently favorited.
func (c *Store) IsFavorite(path string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, p := range c.data.Favorites {
		if p == path {
			return true
		}
	}
	return false
}

// SetFavorite adds or removes a path from favorites. Returns the new
// state (true = favorite, false = not favorite).
func (c *Store) SetFavorite(path string, favorite bool) (bool, error) {
	if path == "" {
		return false, errors.New("empty path")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	idx := -1
	for i, p := range c.data.Favorites {
		if p == path {
			idx = i
			break
		}
	}
	switch {
	case favorite && idx < 0:
		// Prepend so most-recent is first.
		c.data.Favorites = append([]string{path}, c.data.Favorites...)
	case !favorite && idx >= 0:
		c.data.Favorites = append(c.data.Favorites[:idx], c.data.Favorites[idx+1:]...)
	}
	if err := c.saveLocked(); err != nil {
		return favorite, err
	}
	return favorite, nil
}

// ToggleFavorite flips the favorite state of a path. Returns the new state.
func (c *Store) ToggleFavorite(path string) (bool, error) {
	c.mu.RLock()
	isFav := false
	for _, p := range c.data.Favorites {
		if p == path {
			isFav = true
			break
		}
	}
	c.mu.RUnlock()
	return c.SetFavorite(path, !isFav)
}

// -----------------------------------------------------------------------
// Playlists
// -----------------------------------------------------------------------

// GetPlaylists returns all playlists, sorted by most-recently-updated first.
func (c *Store) GetPlaylists() []Playlist {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]Playlist, len(c.data.Playlists))
	copy(out, c.data.Playlists)
	// Return copies with their own Paths slices so mutation of the
	// returned slices doesn't leak back into our state.
	for i := range out {
		paths := make([]string, len(out[i].Paths))
		copy(paths, out[i].Paths)
		out[i].Paths = paths
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out
}

// GetPlaylist returns a single playlist by ID, or an error if not found.
func (c *Store) GetPlaylist(id string) (Playlist, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, p := range c.data.Playlists {
		if p.ID == id {
			cp := p
			cp.Paths = append([]string(nil), p.Paths...)
			return cp, nil
		}
	}
	return Playlist{}, fmt.Errorf("playlist %q not found", id)
}

// CreatePlaylist creates a new, empty playlist and returns it.
func (c *Store) CreatePlaylist(name, description string) (Playlist, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Playlist{}, errors.New("playlist name is required")
	}
	now := time.Now().Unix()
	id, err := randomID()
	if err != nil {
		return Playlist{}, err
	}
	pl := Playlist{
		ID:          id,
		Name:        name,
		Description: strings.TrimSpace(description),
		CreatedAt:   now,
		UpdatedAt:   now,
		Paths:       []string{},
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data.Playlists = append(c.data.Playlists, pl)
	if err := c.saveLocked(); err != nil {
		return Playlist{}, err
	}
	return pl, nil
}

// DeletePlaylist removes a playlist.
func (c *Store) DeletePlaylist(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, p := range c.data.Playlists {
		if p.ID == id {
			c.data.Playlists = append(c.data.Playlists[:i], c.data.Playlists[i+1:]...)
			return c.saveLocked()
		}
	}
	return fmt.Errorf("playlist %q not found", id)
}

// RenamePlaylist updates the name + description of a playlist.
func (c *Store) RenamePlaylist(id, name, description string) (Playlist, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Playlist{}, errors.New("playlist name is required")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.data.Playlists {
		if c.data.Playlists[i].ID == id {
			c.data.Playlists[i].Name = name
			c.data.Playlists[i].Description = strings.TrimSpace(description)
			c.data.Playlists[i].UpdatedAt = time.Now().Unix()
			if err := c.saveLocked(); err != nil {
				return Playlist{}, err
			}
			cp := c.data.Playlists[i]
			cp.Paths = append([]string(nil), cp.Paths...)
			return cp, nil
		}
	}
	return Playlist{}, fmt.Errorf("playlist %q not found", id)
}

// AddToPlaylist appends `paths` to a playlist, skipping any entries
// already present (set semantics — adding the same song twice is a
// no-op). Returns the updated playlist.
func (c *Store) AddToPlaylist(id string, paths []string) (Playlist, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.data.Playlists {
		if c.data.Playlists[i].ID == id {
			existing := make(map[string]struct{}, len(c.data.Playlists[i].Paths))
			for _, p := range c.data.Playlists[i].Paths {
				existing[p] = struct{}{}
			}
			for _, p := range paths {
				p = strings.TrimSpace(p)
				if p == "" {
					continue
				}
				if _, ok := existing[p]; ok {
					continue
				}
				c.data.Playlists[i].Paths = append(c.data.Playlists[i].Paths, p)
				existing[p] = struct{}{}
			}
			c.data.Playlists[i].UpdatedAt = time.Now().Unix()
			if err := c.saveLocked(); err != nil {
				return Playlist{}, err
			}
			cp := c.data.Playlists[i]
			cp.Paths = append([]string(nil), cp.Paths...)
			return cp, nil
		}
	}
	return Playlist{}, fmt.Errorf("playlist %q not found", id)
}

// RemoveFromPlaylist removes `paths` from a playlist.
func (c *Store) RemoveFromPlaylist(id string, paths []string) (Playlist, error) {
	toRemove := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		toRemove[p] = struct{}{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.data.Playlists {
		if c.data.Playlists[i].ID == id {
			kept := c.data.Playlists[i].Paths[:0]
			for _, p := range c.data.Playlists[i].Paths {
				if _, rm := toRemove[p]; rm {
					continue
				}
				kept = append(kept, p)
			}
			c.data.Playlists[i].Paths = kept
			c.data.Playlists[i].UpdatedAt = time.Now().Unix()
			if err := c.saveLocked(); err != nil {
				return Playlist{}, err
			}
			cp := c.data.Playlists[i]
			cp.Paths = append([]string(nil), cp.Paths...)
			return cp, nil
		}
	}
	return Playlist{}, fmt.Errorf("playlist %q not found", id)
}

// ReorderPlaylist replaces the playlist's path list with `paths`. Any
// paths not present in the original list are silently dropped; any
// missing originals are appended to preserve no-data-loss semantics.
func (c *Store) ReorderPlaylist(id string, paths []string) (Playlist, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.data.Playlists {
		if c.data.Playlists[i].ID == id {
			originalSet := make(map[string]struct{}, len(c.data.Playlists[i].Paths))
			for _, p := range c.data.Playlists[i].Paths {
				originalSet[p] = struct{}{}
			}
			seen := make(map[string]struct{}, len(paths))
			reordered := make([]string, 0, len(c.data.Playlists[i].Paths))
			for _, p := range paths {
				if _, ok := originalSet[p]; !ok {
					continue
				}
				if _, dup := seen[p]; dup {
					continue
				}
				reordered = append(reordered, p)
				seen[p] = struct{}{}
			}
			// Append anything the caller forgot — lossless by design.
			for _, p := range c.data.Playlists[i].Paths {
				if _, ok := seen[p]; ok {
					continue
				}
				reordered = append(reordered, p)
			}
			c.data.Playlists[i].Paths = reordered
			c.data.Playlists[i].UpdatedAt = time.Now().Unix()
			if err := c.saveLocked(); err != nil {
				return Playlist{}, err
			}
			cp := c.data.Playlists[i]
			cp.Paths = append([]string(nil), cp.Paths...)
			return cp, nil
		}
	}
	return Playlist{}, fmt.Errorf("playlist %q not found", id)
}

// randomID returns an 8-byte hex ID — unique enough for per-user playlists.
func randomID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
