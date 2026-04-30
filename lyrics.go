package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Lyrics is the structured payload we send back to the frontend.
// If `SyncedLines` is non-empty the UI renders time-synced lyrics; otherwise
// it falls back to `Plain` for a static display.
type Lyrics struct {
	TrackID     int          `json:"trackId"`
	Source      string       `json:"source"`              // always "lrclib" today
	Instrumental bool        `json:"instrumental"`
	Plain       string       `json:"plain,omitempty"`
	SyncedLines []SyncedLine `json:"syncedLines,omitempty"`
}

// SyncedLine is a single `[mm:ss.xx]text` entry from an LRC file.
type SyncedLine struct {
	TimeSec float64 `json:"timeSec"`
	Text    string  `json:"text"`
}

// LyricsService wraps the LRCLIB (<https://lrclib.net>) API. LRCLIB is a free,
// CC0-licensed public database of user-contributed lyrics (both plain and
// `.lrc` time-synced). No API key required.
//
// The service keeps a small in-memory cache keyed on (title|artist|album)
// so moving between views doesn't retrigger a network fetch.
type LyricsService struct {
	client *http.Client
	userAgent string

	mu    sync.Mutex
	cache map[string]Lyrics
}

// NewLyricsService returns an initialised lyrics service.
func NewLyricsService() *LyricsService {
	return &LyricsService{
		client: &http.Client{Timeout: 10 * time.Second},
		userAgent: "Accidia/0.1 (https://github.com/cesp99)",
		cache: make(map[string]Lyrics),
	}
}

// Get resolves lyrics for a track. Returns an empty Lyrics{} (no error) if
// the track simply isn't in the database — that's the common case, not a
// failure condition.
func (s *LyricsService) Get(ctx context.Context, title, artist, album string, duration float64) (Lyrics, error) {
	title = strings.TrimSpace(title)
	artist = strings.TrimSpace(artist)
	album = strings.TrimSpace(album)
	if title == "" || artist == "" {
		return Lyrics{}, nil
	}

	key := cacheKey(title, artist, album)
	s.mu.Lock()
	cached, ok := s.cache[key]
	s.mu.Unlock()
	if ok {
		return cached, nil
	}

	// LRCLIB exposes a `get` endpoint that, given title/artist/album/duration,
	// returns the best-match row. Duration helps disambiguate live vs. studio
	// versions. `duration` is optional — if unknown we just omit it.
	q := url.Values{}
	q.Set("track_name", title)
	q.Set("artist_name", artist)
	if album != "" {
		q.Set("album_name", album)
	}
	if duration > 0 {
		q.Set("duration", strconv.Itoa(int(duration + 0.5)))
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
			s.cacheSet(key, searched)
			return searched, nil
		}
		// Still empty — cache the miss so we don't hammer the API.
		s.cacheSet(key, Lyrics{Source: "lrclib"})
		return Lyrics{Source: "lrclib"}, nil
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
	s.cacheSet(key, out)
	return out, nil
}

// search is the /api/search fallback used when the exact-match /api/get 404s.
// It returns the best-scored hit (LRCLIB orders by relevance server-side).
func (s *LyricsService) search(ctx context.Context, title, artist, album string) (Lyrics, error) {
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

func (s *LyricsService) cacheSet(key string, l Lyrics) {
	s.mu.Lock()
	s.cache[key] = l
	s.mu.Unlock()
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
		out.SyncedLines = parseLRC(row.SyncedLyrics)
	}
	return out, nil
}

// timestampPattern matches `[mm:ss.xx]` or `[mm:ss]` anchors. LRC files can
// carry several timestamps on the same line when lyrics repeat, so we extract
// all of them and fan the line out.
var timestampPattern = regexp.MustCompile(`\[(\d+):(\d+(?:\.\d+)?)\]`)

// parseLRC turns a classic `.lrc` blob into a sorted slice of SyncedLine{}.
// Lines without timestamps (metadata like `[ar:Artist]`) are skipped.
func parseLRC(src string) []SyncedLine {
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
