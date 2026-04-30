//go:build !linux

package mpris

// New returns a no-op Controller on non-Linux platforms. macOS and
// Windows handle system-wide media controls through the browser's
// MediaSession API — which WebKit on macOS and Edge/WebView2 on
// Windows do bridge correctly — so no extra work is needed there.
//
// The interface is identical to the Linux version so app.go doesn't
// have to branch on GOOS.
func New(identity string, handlers Handlers) Controller {
	return stub{}
}

type stub struct{}

func (stub) Start() error                    { return nil }
func (stub) Stop()                           {}
func (stub) Running() bool                   { return false }
func (stub) UpdateMetadata(Metadata)         {}
func (stub) UpdatePlaybackStatus(PlaybackStatus) {}
func (stub) UpdatePosition(float64)          {}
func (stub) UpdateCanGoNext(bool)            {}
func (stub) UpdateCanGoPrevious(bool)        {}
