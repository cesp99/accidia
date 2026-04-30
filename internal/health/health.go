// Package health inspects the host OS for known dependencies missing at
// runtime (primarily GStreamer plugins on Linux) and returns a
// structured summary the frontend can render as a startup banner.
package health

import (
	"os/exec"
	"runtime"
	"strings"
)

// Check summarises per-platform runtime dependencies the frontend
// needs to know about. Right now it only flags the one missing-plugin
// class that causes the dreaded silent `decodeAudioData` failure on
// Linux + WebKit2GTK, but we keep the type open so we can grow it.
type Check struct {
	OK      bool    `json:"ok"`
	Issues  []Issue `json:"issues,omitempty"`
	Checked string  `json:"checked"` // platform identifier for debug
}

// Issue is a single detected problem plus guidance for fixing it.
// `Fix` is shown verbatim in the UI so it should read like a sentence.
type Issue struct {
	ID       string `json:"id"`
	Severity string `json:"severity"` // "error" | "warning"
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Fix      string `json:"fix"`
}

// Run evaluates the current platform and returns a summary the
// frontend can render as a startup banner. It intentionally does NOT
// bubble errors back up — a missing dependency is user-fixable and the
// UI should stay alive to tell them how.
func Run() Check {
	hc := Check{
		OK:      true,
		Checked: runtime.GOOS,
	}

	switch runtime.GOOS {
	case "linux":
		if issue, ok := checkGStreamer(); !ok {
			hc.OK = false
			hc.Issues = append(hc.Issues, issue)
		}
	case "windows", "darwin":
		// Both platforms ship a working Web Audio implementation with the
		// system webview, no extra codecs required.
	}
	return hc
}

// checkGStreamer verifies WebKit2GTK's audio stack has the plugins
// required for `decodeAudioData` and audio output to work. Specifically:
//   - `autoaudiosink` from gst-plugins-good — needed for Web Audio output.
//   - `audioresample` from gst-plugins-base — needed for sample-rate
//     conversion inside the graph.
//
// If either is missing, we emit a single issue telling the user what to
// install. We use `gst-inspect-1.0`, which ships with the core gstreamer
// package on every distro.
func checkGStreamer() (Issue, bool) {
	bin, err := exec.LookPath("gst-inspect-1.0")
	if err != nil {
		// Can't verify either way — don't scare the user if they already
		// have audio working. Return "ok" and let a real failure bubble
		// up through the decode path instead.
		return Issue{}, true
	}
	required := []string{"autoaudiosink", "audioresample"}
	var missing []string
	for _, name := range required {
		cmd := exec.Command(bin, name)
		if err := cmd.Run(); err != nil {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return Issue{}, true
	}

	return Issue{
		ID:       "linux-gst-plugins-good",
		Severity: "error",
		Title:    "Audio backend is missing GStreamer plugins",
		Detail: "WebKit2GTK needs the `" + strings.Join(missing, "`, `") +
			"` element(s) from gst-plugins-good to decode and play audio. " +
			"Without them, playback silently fails with `Decoding failed`.",
		Fix: LinuxFixHint(),
	}, false
}

// LinuxFixHint returns a per-distro install command. Detection is
// heuristic (based on which package manager is on PATH) and falls back
// to a generic instruction if we can't tell.
func LinuxFixHint() string {
	if _, err := exec.LookPath("pacman"); err == nil {
		return "sudo pacman -S gst-plugins-good"
	}
	if _, err := exec.LookPath("apt"); err == nil {
		return "sudo apt install gstreamer1.0-plugins-good"
	}
	if _, err := exec.LookPath("dnf"); err == nil {
		return "sudo dnf install gstreamer1-plugins-good"
	}
	if _, err := exec.LookPath("zypper"); err == nil {
		return "sudo zypper install gstreamer-plugins-good"
	}
	if _, err := exec.LookPath("xbps-install"); err == nil {
		return "sudo xbps-install -S gst-plugins-good1"
	}
	return "Install the gst-plugins-good package for your distribution."
}
