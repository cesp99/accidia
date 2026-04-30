package lyrics_test

import (
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/lyrics"
)

func TestParseLRC(t *testing.T) {
	src := `[ar:Test Artist]
[ti:Test Title]
[00:12.34]First line
[00:18.56]Second line
[01:05.00][02:10.00]Repeated line
`
	lines := lyrics.ParseLRC(src)
	if len(lines) != 4 {
		t.Fatalf("got %d lines, want 4", len(lines))
	}
	if lines[0].TimeSec != 12.34 || lines[0].Text != "First line" {
		t.Errorf("line 0 = %+v", lines[0])
	}
	if lines[3].TimeSec != 130.0 || lines[3].Text != "Repeated line" {
		t.Errorf("line 3 = %+v", lines[3])
	}
}
