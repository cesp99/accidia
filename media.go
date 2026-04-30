package main

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

// MediaStore keeps recently-decoded audio in memory, keyed by a random
// token, and serves the bytes through Wails's asset server. Using HTTP
// over the internal port keeps us off the JSON-IPC bus (which is brittle
// above ~10 MB on WebKit2GTK) and lets the browser's Web Audio pipeline
// stream the body into `decodeAudioData` efficiently.
//
// The store implements a tiny LRU — older entries are evicted once the
// maximum is reached so long listening sessions can't leak unbounded RAM.
type MediaStore struct {
	mu      sync.Mutex
	entries map[string]*mediaEntry
	order   []string // oldest first
	limit   int
}

type mediaEntry struct {
	bytes     []byte
	mime      string
	createdAt time.Time
}

// NewMediaStore returns a MediaStore that keeps up to `limit` entries
// alive. 3 is a reasonable ceiling for a music player: current track,
// previously-played, and a preloaded next track.
func NewMediaStore(limit int) *MediaStore {
	if limit < 1 {
		limit = 1
	}
	return &MediaStore{
		entries: make(map[string]*mediaEntry, limit),
		limit:   limit,
	}
}

// Put registers a new payload and returns a stable URL path the frontend
// can fetch. The token is random so we don't leak filesystem paths.
func (m *MediaStore) Put(mime string, body []byte) (string, error) {
	if len(body) == 0 {
		return "", errors.New("media: empty payload")
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for len(m.order)+1 > m.limit {
		old := m.order[0]
		m.order = m.order[1:]
		delete(m.entries, old)
	}
	m.entries[token] = &mediaEntry{
		bytes:     body,
		mime:      mime,
		createdAt: time.Now(),
	}
	m.order = append(m.order, token)
	return "/media/" + token, nil
}

// Clear drops all cached entries. Useful on track change if we want to
// free memory aggressively.
func (m *MediaStore) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries = make(map[string]*mediaEntry)
	m.order = nil
}

// ServeHTTP is the asset server handler. Wails routes any request whose
// path isn't served by the embedded filesystem through us; we match
// `/media/<token>` and write the cached bytes back.
func (m *MediaStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	entry := m.entries[token]
	m.mu.Unlock()
	if entry == nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", entry.mime)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(entry.bytes)))
	// Cache for a while — the token is per-decode so there's no staleness
	// concern, and Web Audio may request ranges.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(entry.bytes)
}

// randomToken produces a URL-safe hex token.
func randomToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
