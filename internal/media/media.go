// Package media keeps recently-decoded audio in memory, keyed by a
// random token, and serves the bytes through Wails's asset server as
// an HTTP handler. Using HTTP over the internal port keeps us off the
// JSON-IPC bus (which is brittle above ~10 MB on WebKit2GTK) and lets
// the browser's Web Audio pipeline stream the body efficiently.
//
// A secondary "dedup key" (typically the absolute file path + mtime)
// lets callers reuse an existing entry across repeat decodes — the
// frontend's prefetch pipeline relies on this to make Next-track
// switching near-instant.
package media

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Store implements http.Handler. It keeps a tiny LRU — older entries
// are evicted once the maximum is reached so long listening sessions
// can't leak unbounded RAM.
type Store struct {
	mu      sync.Mutex
	entries map[string]*entry
	byKey   map[string]string // user-provided dedup key -> token
	order   []string          // oldest first
	limit   int
}

type entry struct {
	bytes     []byte
	mime      string
	key       string // the dedup key the caller supplied, "" when none
	createdAt time.Time
}

// New returns a Store that keeps up to `limit` entries alive. 8 is a
// reasonable ceiling for a music player: current track, preloaded next,
// plus a handful of recently-played tracks warm for fast back-navigation.
func New(limit int) *Store {
	if limit < 1 {
		limit = 1
	}
	return &Store{
		entries: make(map[string]*entry, limit),
		byKey:   make(map[string]string, limit),
		limit:   limit,
	}
}

// Put registers a new payload keyed by `key` (typically the track path
// plus its mtime for cache invalidation on file change). If a payload
// with the same key is already present, returns its existing URL and
// bumps it to most-recently-used — skipping the decode work upstream.
// Pass an empty key to opt out of dedup (fresh token every time).
func (m *Store) Put(mime string, body []byte, key string) (string, error) {
	if len(body) == 0 {
		return "", errors.New("media: empty payload")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	// Cache hit: return existing URL, bump LRU.
	if key != "" {
		if token, ok := m.byKey[key]; ok {
			if _, live := m.entries[token]; live {
				m.bumpLocked(token)
				return "/media/" + token, nil
			}
			// Stale mapping (the entry was evicted but byKey wasn't
			// cleaned up — shouldn't happen with the new eviction
			// path, but defensive).
			delete(m.byKey, key)
		}
	}

	token, err := randomToken()
	if err != nil {
		return "", err
	}
	// Evict oldest entries until there's room for the new one.
	for len(m.order)+1 > m.limit {
		old := m.order[0]
		m.order = m.order[1:]
		if oldEntry := m.entries[old]; oldEntry != nil && oldEntry.key != "" {
			delete(m.byKey, oldEntry.key)
		}
		delete(m.entries, old)
	}
	m.entries[token] = &entry{
		bytes:     body,
		mime:      mime,
		key:       key,
		createdAt: time.Now(),
	}
	m.order = append(m.order, token)
	if key != "" {
		m.byKey[key] = token
	}
	return "/media/" + token, nil
}

// Has reports whether the given URL (returned previously by Put) is
// still live. Callers with an external metadata cache use this to
// check whether they can return their cached metadata without
// re-decoding.
func (m *Store) Has(url string) bool {
	token := strings.TrimPrefix(url, "/media/")
	if token == "" || token == url {
		return false
	}
	if i := strings.IndexAny(token, "/?"); i != -1 {
		token = token[:i]
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.entries[token]
	return ok
}

// Clear drops all cached entries. Useful on track change if we want to
// free memory aggressively.
func (m *Store) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries = make(map[string]*entry)
	m.byKey = make(map[string]string)
	m.order = nil
}

// bumpLocked moves the given token to the end of the LRU order.
// Caller must hold m.mu.
func (m *Store) bumpLocked(token string) {
	for i, t := range m.order {
		if t == token {
			m.order = append(m.order[:i], m.order[i+1:]...)
			m.order = append(m.order, token)
			return
		}
	}
}

// ServeHTTP is the asset server handler. Wails routes any request whose
// path isn't served by the embedded filesystem through us; we match
// `/media/<token>` and write the cached bytes back.
func (m *Store) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if !strings.HasPrefix(path, "media/") {
		http.NotFound(w, r)
		return
	}
	token := strings.TrimPrefix(path, "media/")
	if i := strings.IndexAny(token, "/?"); i != -1 {
		token = token[:i]
	}

	m.mu.Lock()
	e := m.entries[token]
	m.mu.Unlock()
	if e == nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", e.mime)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(e.bytes)))
	// Cache for a while — the token is per-decode so there's no staleness
	// concern, and Web Audio may request ranges.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(e.bytes)
}

// randomToken produces a URL-safe hex token.
func randomToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
