package media_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/media"
)

func TestMediaStore_PutAndServe(t *testing.T) {
	store := media.New(3)
	body := []byte("RIFF\x00\x00\x00\x00WAVEfmt payload")
	url, err := store.Put("audio/wav", body)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if url == "" {
		t.Fatal("empty URL")
	}

	// Emulate the asset server routing a request through us.
	req := httptest.NewRequest(http.MethodGet, url, nil)
	w := httptest.NewRecorder()
	store.ServeHTTP(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "audio/wav" {
		t.Errorf("content-type = %q, want audio/wav", ct)
	}
	got, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(got, body) {
		t.Error("body mismatch")
	}
}

func TestMediaStore_HeadRequest(t *testing.T) {
	store := media.New(3)
	body := make([]byte, 1024)
	url, _ := store.Put("audio/wav", body)

	req := httptest.NewRequest(http.MethodHead, url, nil)
	w := httptest.NewRecorder()
	store.ServeHTTP(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d", resp.StatusCode)
	}
	if resp.Header.Get("Content-Length") != "1024" {
		t.Errorf("content-length = %q", resp.Header.Get("Content-Length"))
	}
	// HEAD should not include body.
	got, _ := io.ReadAll(resp.Body)
	if len(got) != 0 {
		t.Errorf("HEAD returned %d bytes of body", len(got))
	}
}

func TestMediaStore_LRUEviction(t *testing.T) {
	store := media.New(2)
	url1, _ := store.Put("audio/wav", []byte("one"))
	url2, _ := store.Put("audio/wav", []byte("two"))
	url3, _ := store.Put("audio/wav", []byte("three"))

	// url1 should have been evicted
	w := httptest.NewRecorder()
	store.ServeHTTP(w, httptest.NewRequest(http.MethodGet, url1, nil))
	if w.Result().StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for evicted url1, got %d", w.Result().StatusCode)
	}

	// url2 + url3 should still be live
	for _, u := range []string{url2, url3} {
		w := httptest.NewRecorder()
		store.ServeHTTP(w, httptest.NewRequest(http.MethodGet, u, nil))
		if w.Result().StatusCode != http.StatusOK {
			t.Errorf("expected 200 for %s, got %d", u, w.Result().StatusCode)
		}
	}
}

func TestMediaStore_NotFound(t *testing.T) {
	store := media.New(3)
	req := httptest.NewRequest(http.MethodGet, "/media/bogus-token", nil)
	w := httptest.NewRecorder()
	store.ServeHTTP(w, req)
	if w.Result().StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Result().StatusCode)
	}
}

func TestMediaStore_IgnoresNonMediaPaths(t *testing.T) {
	store := media.New(3)
	// Paths that don't start with /media/ should 404 (they would normally
	// be served by the asset server's embedded assets; we only handle
	// /media/).
	req := httptest.NewRequest(http.MethodGet, "/assets/index.js", nil)
	w := httptest.NewRecorder()
	store.ServeHTTP(w, req)
	if w.Result().StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Result().StatusCode)
	}
}
