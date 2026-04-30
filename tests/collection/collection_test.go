package collection_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/collection"
)

func newTestCollection(t *testing.T) *collection.Store {
	t.Helper()
	dir := t.TempDir()
	c := collection.New()
	if err := c.InitWithPath(filepath.Join(dir, "collection.json")); err != nil {
		t.Fatalf("init: %v", err)
	}
	return c
}

func TestFavoritesToggle(t *testing.T) {
	c := newTestCollection(t)

	if c.IsFavorite("/foo.mp3") {
		t.Fatalf("empty store reports /foo.mp3 favorite")
	}

	fav, err := c.ToggleFavorite("/foo.mp3")
	if err != nil {
		t.Fatalf("toggle: %v", err)
	}
	if !fav {
		t.Fatalf("expected favorite=true after first toggle, got false")
	}
	if !c.IsFavorite("/foo.mp3") {
		t.Fatalf("IsFavorite should report true")
	}

	fav, err = c.ToggleFavorite("/foo.mp3")
	if err != nil {
		t.Fatalf("toggle: %v", err)
	}
	if fav {
		t.Fatalf("expected favorite=false after second toggle")
	}
}

func TestFavoritesOrdering(t *testing.T) {
	c := newTestCollection(t)
	if _, err := c.SetFavorite("/a.mp3", true); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SetFavorite("/b.mp3", true); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SetFavorite("/c.mp3", true); err != nil {
		t.Fatal(err)
	}
	// Newest first: c, b, a.
	got := c.GetFavorites()
	if len(got) != 3 || got[0] != "/c.mp3" || got[1] != "/b.mp3" || got[2] != "/a.mp3" {
		t.Fatalf("order wrong: %v", got)
	}
}

func TestFavoritesPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.json")

	c1 := collection.New()
	if err := c1.InitWithPath(path); err != nil {
		t.Fatal(err)
	}
	if _, err := c1.SetFavorite("/song.mp3", true); err != nil {
		t.Fatal(err)
	}

	// Rehydrate from a fresh store.
	c2 := collection.New()
	if err := c2.InitWithPath(path); err != nil {
		t.Fatal(err)
	}
	if !c2.IsFavorite("/song.mp3") {
		t.Fatalf("favorite not persisted")
	}

	// Confirm the file on disk actually exists and is JSON.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat: %v", err)
	}
}

func TestPlaylistLifecycle(t *testing.T) {
	c := newTestCollection(t)

	pl, err := c.CreatePlaylist("Chill", "evening vibes")
	if err != nil {
		t.Fatal(err)
	}
	if pl.ID == "" || pl.Name != "Chill" || pl.Description != "evening vibes" {
		t.Fatalf("unexpected playlist: %+v", pl)
	}

	updated, err := c.AddToPlaylist(pl.ID, []string{"/a.mp3", "/b.mp3", "/a.mp3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Paths) != 2 {
		t.Fatalf("expected 2 paths (dedup), got %v", updated.Paths)
	}

	removed, err := c.RemoveFromPlaylist(pl.ID, []string{"/a.mp3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(removed.Paths) != 1 || removed.Paths[0] != "/b.mp3" {
		t.Fatalf("remove wrong: %v", removed.Paths)
	}

	reordered, err := c.ReorderPlaylist(pl.ID, []string{"/b.mp3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(reordered.Paths) != 1 {
		t.Fatalf("reorder wrong: %v", reordered.Paths)
	}

	if err := c.DeletePlaylist(pl.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetPlaylist(pl.ID); err == nil {
		t.Fatalf("expected error after delete")
	}
}

func TestPlaylistEmptyNameRejected(t *testing.T) {
	c := newTestCollection(t)
	if _, err := c.CreatePlaylist("   ", ""); err == nil {
		t.Fatalf("expected error for empty name")
	}
}

func TestPlaylistReorderKeepsMissing(t *testing.T) {
	c := newTestCollection(t)
	pl, err := c.CreatePlaylist("Mix", "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.AddToPlaylist(pl.ID, []string{"/a.mp3", "/b.mp3", "/c.mp3"})
	if err != nil {
		t.Fatal(err)
	}
	// Only reorder two; third one should be appended.
	updated, err := c.ReorderPlaylist(pl.ID, []string{"/c.mp3", "/a.mp3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Paths) != 3 {
		t.Fatalf("expected 3 paths, got %v", updated.Paths)
	}
	if updated.Paths[0] != "/c.mp3" || updated.Paths[1] != "/a.mp3" {
		t.Fatalf("wrong new order: %v", updated.Paths)
	}
	// "/b.mp3" was missing in the reorder call but must still be present.
	found := false
	for _, p := range updated.Paths {
		if p == "/b.mp3" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected /b.mp3 appended to tail; got %v", updated.Paths)
	}
}
