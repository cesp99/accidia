package mpris_test

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/mpris"
)

// 1x1 transparent PNG ("\x89PNG...IEND\xaeB`\x82") small enough that the
// hash check of its decoded bytes is trivial.
const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII="

func TestArtCacheKey_Stable(t *testing.T) {
	k1 := mpris.ArtCacheKey("/music/a.mp3", "data:image/png;base64,"+pngB64)
	k2 := mpris.ArtCacheKey("/music/a.mp3", "data:image/png;base64,"+pngB64)
	if k1 != k2 {
		t.Fatalf("same input produced different keys: %q != %q", k1, k2)
	}
	if len(k1) != 40 { // sha1 = 40 hex chars
		t.Fatalf("unexpected key length %d: %q", len(k1), k1)
	}
}

func TestArtCacheKey_DifferentTrackDifferentKey(t *testing.T) {
	k1 := mpris.ArtCacheKey("/music/a.mp3", "data:image/png;base64,"+pngB64)
	k2 := mpris.ArtCacheKey("/music/b.mp3", "data:image/png;base64,"+pngB64)
	if k1 == k2 {
		t.Fatal("expected different tracks to produce different keys")
	}
}

func TestWriteDataURLToCache_PNG(t *testing.T) {
	dir := t.TempDir()
	key := "abc123"
	url := "data:image/png;base64," + pngB64

	path, ok := mpris.WriteDataURLToCache(url, dir, key)
	if !ok {
		t.Fatal("WriteDataURLToCache returned false for valid PNG data URL")
	}
	if !strings.HasSuffix(path, ".png") {
		t.Errorf("expected .png extension, got %q", path)
	}
	if filepath.Dir(path) != dir {
		t.Errorf("file written outside cache dir: %q not under %q", path, dir)
	}

	// The decoded bytes should match the raw base64 payload.
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read cached file: %v", err)
	}
	want, _ := base64.StdEncoding.DecodeString(pngB64)
	if string(got) != string(want) {
		t.Errorf("cached bytes don't match decoded data URL payload")
	}
}

func TestWriteDataURLToCache_Rejects(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name string
		url  string
	}{
		{"non-data scheme", "https://example.com/cover.png"},
		{"missing comma", "data:image/png;base64abcd"},
		{"non-base64", "data:image/png," + pngB64},
		{"invalid base64", "data:image/png;base64,!!!not-base64!!!"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, ok := mpris.WriteDataURLToCache(c.url, dir, "key")
			if ok || path != "" {
				t.Fatalf("expected rejection, got ok=%v path=%q", ok, path)
			}
		})
	}
}

func TestExtForMIME(t *testing.T) {
	cases := map[string]string{
		"image/jpeg": ".jpg",
		"image/jpg":  ".jpg",
		"image/png":  ".png",
		"image/webp": ".webp",
		"image/gif":  ".gif",
		"image/bmp":  ".bin", // unsupported → generic extension
		"":           ".bin",
	}
	for mime, wantExt := range cases {
		if got := mpris.ExtForMIME(mime); got != wantExt {
			t.Errorf("ExtForMIME(%q) = %q; want %q", mime, got, wantExt)
		}
	}
}
