package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Settings is the small JSON blob persisted between sessions.
type Settings struct {
	LibraryRoot     string  `json:"libraryRoot,omitempty"`
	Volume          float64 `json:"volume"`
	JumpProbability float64 `json:"jumpProbability"`
	JumpCooldown    float64 `json:"jumpCooldown"`
	LastTrackPath   string  `json:"lastTrackPath,omitempty"`
	WindowWidth     int     `json:"windowWidth,omitempty"`
	WindowHeight    int     `json:"windowHeight,omitempty"`
}

// defaultSettings is what we fall back to on a fresh install.
func defaultSettings() Settings {
	return Settings{
		Volume:          1.0,
		JumpProbability: 0.25,
		JumpCooldown:    2.0,
	}
}

// Store persists settings + library cache to the user's app data directory.
// All disk writes go through a goroutine-safe lock so we can safely call
// SaveSettings + SaveLibrary from multiple bound methods.
type Store struct {
	mu sync.RWMutex

	dir          string
	settingsPath string
	libraryPath  string

	settings Settings
	library  *LibraryScanResult
}

// NewStore returns an unitialised store. Call Init() before using it.
func NewStore() *Store {
	return &Store{settings: defaultSettings()}
}

// Init resolves the user's app data directory and loads any existing
// settings/library cache. Missing files are not errors.
func (s *Store) Init() error {
	dir, err := userConfigDir("Accidia")
	if err != nil {
		return fmt.Errorf("user config dir: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	s.mu.Lock()
	s.dir = dir
	s.settingsPath = filepath.Join(dir, "settings.json")
	s.libraryPath = filepath.Join(dir, "library.json")
	s.mu.Unlock()

	if err := s.loadSettings(); err != nil {
		return err
	}
	return s.loadLibrary()
}

// Flush persists everything currently in memory. Safe to call repeatedly.
func (s *Store) Flush() error {
	if err := s.SaveSettings(s.Settings()); err != nil {
		return err
	}
	if cached, ok := s.Library(); ok {
		if err := s.SaveLibrary(cached); err != nil {
			return err
		}
	}
	return nil
}

// Settings returns a copy of the current settings.
func (s *Store) Settings() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

// SaveSettings writes the given settings to disk.
func (s *Store) SaveSettings(in Settings) error {
	s.mu.Lock()
	s.settings = in
	path := s.settingsPath
	s.mu.Unlock()
	if path == "" {
		return errors.New("store not initialised")
	}
	return writeJSON(path, in)
}

// Library returns the cached library + true, or zero+false if there's no cache.
func (s *Store) Library() (LibraryScanResult, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.library == nil {
		return LibraryScanResult{}, false
	}
	return *s.library, true
}

// SaveLibrary persists the latest scan result to disk.
func (s *Store) SaveLibrary(in LibraryScanResult) error {
	s.mu.Lock()
	cp := in
	s.library = &cp
	path := s.libraryPath
	s.mu.Unlock()
	if path == "" {
		return errors.New("store not initialised")
	}
	return writeJSON(path, in)
}

// loadSettings reads settings.json if it exists. Missing file → defaults.
func (s *Store) loadSettings() error {
	s.mu.RLock()
	path := s.settingsPath
	s.mu.RUnlock()

	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	var loaded Settings
	if err := json.Unmarshal(data, &loaded); err != nil {
		return fmt.Errorf("parse settings: %w", err)
	}
	if loaded.Volume == 0 {
		loaded.Volume = 1.0
	}
	s.mu.Lock()
	s.settings = loaded
	s.mu.Unlock()
	return nil
}

// loadLibrary reads the library cache if it exists.
func (s *Store) loadLibrary() error {
	s.mu.RLock()
	path := s.libraryPath
	s.mu.RUnlock()

	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	var loaded LibraryScanResult
	if err := json.Unmarshal(data, &loaded); err != nil {
		return fmt.Errorf("parse library: %w", err)
	}
	s.mu.Lock()
	s.library = &loaded
	s.mu.Unlock()
	return nil
}

// writeJSON pretty-prints `v` to `path`. Atomic enough for our needs:
// write to a sibling .tmp then rename.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// userConfigDir returns the per-user config directory for our app:
//   - Linux:   $XDG_CONFIG_HOME/Accidia or ~/.config/Accidia
//   - macOS:   ~/Library/Application Support/Accidia
//   - Windows: %APPDATA%/Accidia
func userConfigDir(name string) (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, name), nil
}
