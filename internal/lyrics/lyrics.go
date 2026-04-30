// Package lyrics fetches time-synced lyrics from LRCLIB (<https://lrclib.net>),
// a free CC0-licensed database, with a two-tier (memory + disk) cache
// so we don't re-hit the network across app restarts.
package lyrics

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cesp99/infinite-jukebox/internal/store"
)

// Lyrics is the structured payload we send back to the frontend.
// If `SyncedLines` is non-empty the UI renders time-synced lyrics; otherwise
// it falls back to `Plain` for a static display.
type Lyrics struct {
	TrackID      int          `json:"trackId"`
	Source       string       `json:"source"` // always "lrclib" today
	Instrumental bool         `json:"instrumental"`
	Plain        string       `json:"plain,omitempty"`
	SyncedLines  []SyncedLine `json:"syncedLines,omitempty"`
}

// SyncedLine is a single `[mm:ss.xx]text` entry from an LRC file.
type SyncedLine struct {
	TimeSec float64 `json:"timeSec"`
	Text    string  `json:"text"`
}

// Service wraps the LRCLIB API with a two-tier cache:
//   - An in-memory map keyed on (title|artist|album) so moving between views
//     doesn't hit the filesystem.
//   - A per-key JSON file on disk so restarts don't re-hit the network. A
//     miss is cached for 7 days (so we retry later in case the track gets
//     added); a hit is cached for 90 days.
type Service struct {
	client    *http.Client
	userAgent string

	mu       sync.Mutex
	cache    map[string]Lyrics
	cacheDir string
}

// diskCacheEntry is what we persist to disk. We wrap the lyrics payload
// with a timestamp + miss flag so we can expire old misses without
// forcing a retry on every launch.
type diskCacheEntry struct {
	SavedAt int64  `json:"savedAt"`
	Miss    bool   `json:"miss"`
	Payload Lyrics `json:"payload"`
}

const (
	hitTTL  = 90 * 24 * time.Hour
	missTTL = 7 * 24 * time.Hour
)

// NewService returns an initialised lyrics service with its disk cache
// rooted at the user's app data directory. The cache directory is
// created lazily on first write.
func NewService() *Service {
	s := &Service{
		client:    &http.Client{Timeout: 10 * time.Second},
		userAgent: "Accidia/0.1 (https://github.com/cesp99)",
		cache:     make(map[string]Lyrics),
	}
	if base, err := store.UserConfigDir("Accidia"); err == nil {
		s.cacheDir = filepath.Join(base, "lyrics-cache")
	}
	return s
}

// WithCacheDir pins the on-disk cache directory, primarily for tests
// that want a hermetic location.
func (s *Service) WithCacheDir(dir string) *Service {
	s.mu.Lock()
	s.cacheDir = dir
	s.mu.Unlock()
	return s
}

// Get resolves lyrics for a track. Returns an empty Lyrics{} (no error) if
// the track simply isn't in the database — that's the common case, not a
// failure condition.
func (s *Service) Get(ctx context.Context, title, artist, album string, duration float64) (Lyrics, error) {
	title = strings.TrimSpace(title)
	artist = strings.TrimSpace(artist)
	album = strings.TrimSpace(album)
	if title == "" || artist == "" {
		return Lyrics{}, nil
	}

	key := cacheKey(title, artist, album)
	// Tier 1 — in-memory cache.
	s.mu.Lock()
	cached, ok := s.cache[key]
	s.mu.Unlock()
	if ok {
		return cached, nil
	}

	// Tier 2 — disk cache. Populate the in-memory cache if hit.
	if l, ok := s.loadFromDisk(key); ok {
		s.mu.Lock()
		s.cache[key] = l
		s.mu.Unlock()
		return l, nil
	}

	// Cache miss at both tiers — go to the network.
	q := url.Values{}
	q.Set("track_name", title)
	q.Set("artist_name", artist)
	if album != "" {
		q.Set("album_name", album)
	}
	if duration > 0 {
		q.Set("duration", strconv.Itoa(int(duration+0.5)))
	}
	endpoint := "https://lrclib.net/api/get?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Lyrics{}, err
	}
	req.Header.Set("User-Agent", s.userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return Lyrics{}, fmt.Errorf("lrclib: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		// Try the /api/search fallback which does a fuzzier match.
		searched, err := s.search(ctx, title, artist, album)
		if err == nil && searched.TrackID != 0 {
			s.cacheSet(key, searched, false)
			return searched, nil
		}
		// Still empty — cache the miss so we don't hammer the API.
		miss := Lyrics{Source: "lrclib"}
		s.cacheSet(key, miss, true)
		return miss, nil
	}
	if resp.StatusCode != http.StatusOK {
		return Lyrics{}, fmt.Errorf("lrclib: status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Lyrics{}, fmt.Errorf("lrclib read: %w", err)
	}
	out, err := parseLrcLibResponse(body)
	if err != nil {
		return Lyrics{}, err
	}
	s.cacheSet(key, out, out.TrackID == 0 && out.Plain == "" && len(out.SyncedLines) == 0 && !out.Instrumental)
	return out, nil
}

// search is the /api/search fallback used when the exact-match /api/get 404s.
// It returns the best-scored hit (LRCLIB orders by relevance server-side).
func (s *Service) search(ctx context.Context, title, artist, album string) (Lyrics, error) {
	q := url.Values{}
	q.Set("track_name", title)
	q.Set("artist_name", artist)
	if album != "" {
		q.Set("album_name", album)
	}
	endpoint := "https://lrclib.net/api/search?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Lyrics{}, err
	}
	req.Header.Set("User-Agent", s.userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return Lyrics{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Lyrics{}, fmt.Errorf("lrclib search: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Lyrics{}, err
	}
	// The search endpoint returns a JSON array; pick the first result.
	var arr []json.RawMessage
	if err := json.Unmarshal(body, &arr); err != nil {
		return Lyrics{}, fmt.Errorf("lrclib search parse: %w", err)
	}
	if len(arr) == 0 {
		return Lyrics{Source: "lrclib"}, nil
	}
	return parseLrcLibResponse(arr[0])
}

// cacheSet writes to the in-memory cache and mirrors the entry to disk.
// `miss` should be true for negative cache entries so we can expire them
// sooner than actual hits.
func (s *Service) cacheSet(key string, l Lyrics, miss bool) {
	s.mu.Lock()
	s.cache[key] = l
	s.mu.Unlock()
	s.saveToDisk(key, l, miss)
}

// diskCachePath returns the on-disk JSON path for a given cache key.
// The key is SHA-1'd so we don't need to worry about path-hostile chars
// in track names (the cache key already lower-cases + strips, but slashes
// in titles are legal).
func (s *Service) diskCachePath(key string) string {
	s.mu.Lock()
	dir := s.cacheDir
	s.mu.Unlock()
	if dir == "" {
		return ""
	}
	sum := sha1.Sum([]byte(key))
	return filepath.Join(dir, hex.EncodeToString(sum[:])+".json")
}

// loadFromDisk tries to read a cached entry for this key. Returns
// (Lyrics, true) only on a live (non-expired) cache entry; any read or
// decode error is swallowed silently so we'll just go to the network.
func (s *Service) loadFromDisk(key string) (Lyrics, bool) {
	path := s.diskCachePath(key)
	if path == "" {
		return Lyrics{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Lyrics{}, false
	}
	var entry diskCacheEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return Lyrics{}, false
	}
	// Legacy payloads written before we introduced the wrapper — if
	// nothing unmarshalled into SavedAt, treat them as a raw Lyrics.
	if entry.SavedAt == 0 {
		var raw Lyrics
		if err := json.Unmarshal(data, &raw); err == nil && (raw.Source != "" || raw.Plain != "" || len(raw.SyncedLines) > 0) {
			return raw, true
		}
		return Lyrics{}, false
	}
	saved := time.Unix(entry.SavedAt, 0)
	ttl := hitTTL
	if entry.Miss {
		ttl = missTTL
	}
	if time.Since(saved) > ttl {
		// Stale — let the caller refetch. We leave the file in place;
		// saveToDisk will overwrite on the next successful lookup.
		return Lyrics{}, false
	}
	return entry.Payload, true
}

// saveToDisk writes the cache entry to disk, best-effort. Errors are
// logged to stderr at most and never surfaced to the caller — a failed
// disk write just means we'll retry on next launch.
func (s *Service) saveToDisk(key string, l Lyrics, miss bool) {
	path := s.diskCachePath(key)
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	entry := diskCacheEntry{
		SavedAt: time.Now().Unix(),
		Miss:    miss,
		Payload: l,
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// cacheKey normalises input so that "Song " and "song" hit the same entry.
func cacheKey(title, artist, album string) string {
	n := func(s string) string {
		return strings.ToLower(strings.TrimSpace(s))
	}
	return n(title) + "|" + n(artist) + "|" + n(album)
}

// lrcLibRow is the subset of fields we care about from LRCLIB responses.
type lrcLibRow struct {
	ID           int     `json:"id"`
	Name         string  `json:"name"`
	ArtistName   string  `json:"artistName"`
	AlbumName    string  `json:"albumName"`
	Duration     float64 `json:"duration"`
	Instrumental bool    `json:"instrumental"`
	PlainLyrics  string  `json:"plainLyrics"`
	SyncedLyrics string  `json:"syncedLyrics"`
}

// parseLrcLibResponse converts an LRCLIB JSON body into our Lyrics struct.
func parseLrcLibResponse(body []byte) (Lyrics, error) {
	var row lrcLibRow
	if err := json.Unmarshal(body, &row); err != nil {
		return Lyrics{}, fmt.Errorf("lrclib parse: %w", err)
	}
	out := Lyrics{
		TrackID:      row.ID,
		Source:       "lrclib",
		Instrumental: row.Instrumental,
		Plain:        row.PlainLyrics,
	}
	if strings.TrimSpace(row.SyncedLyrics) != "" {
		out.SyncedLines = ParseLRC(row.SyncedLyrics)
	}
	return out, nil
}

// timestampPattern matches `[mm:ss.xx]` or `[mm:ss]` anchors. LRC files can
// carry several timestamps on the same line when lyrics repeat, so we extract
// all of them and fan the line out.
var timestampPattern = regexp.MustCompile(`\[(\d+):(\d+(?:\.\d+)?)\]`)

// ParseLRC turns a classic `.lrc` blob into a sorted slice of SyncedLine{}.
// Lines without timestamps (metadata like `[ar:Artist]`) are skipped.
// Exported so tests can exercise it directly.
func ParseLRC(src string) []SyncedLine {
	lines := strings.Split(src, "\n")
	out := make([]SyncedLine, 0, len(lines))

	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		// Strip & collect every [mm:ss.xx] at the start.
		matches := timestampPattern.FindAllStringSubmatchIndex(line, -1)
		if len(matches) == 0 {
			continue
		}
		// Text is everything after the last timestamp.
		lastEnd := matches[len(matches)-1][1]
		text := strings.TrimSpace(line[lastEnd:])
		// Skip bare metadata tags like [ar:...] that timestampPattern still
		// happens to match — those have non-numeric submatches so the regex
		// already excludes them. Safe by construction.
		for _, m := range matches {
			mm, _ := strconv.Atoi(line[m[2]:m[3]])
			ss, _ := strconv.ParseFloat(line[m[4]:m[5]], 64)
			t := float64(mm)*60 + ss
			out = append(out, SyncedLine{TimeSec: t, Text: text})
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		return out[i].TimeSec < out[j].TimeSec
	})
	return out
}
