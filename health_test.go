package main

import (
	"runtime"
	"testing"
)

func TestHealthCheck_ReturnsPlatform(t *testing.T) {
	hc := RunHealthCheck()
	if hc.Checked != runtime.GOOS {
		t.Errorf("Checked = %q, want %q", hc.Checked, runtime.GOOS)
	}
}

func TestLinuxFixHint_PicksAPackageManager(t *testing.T) {
	hint := linuxFixHint()
	if hint == "" {
		t.Error("empty hint")
	}
	// Something vaguely useful no matter the distro
	if !containsAny(hint, []string{"pacman", "apt", "dnf", "zypper", "xbps-install", "gst-plugins-good"}) {
		t.Errorf("unhelpful hint: %q", hint)
	}
}

func containsAny(s string, needles []string) bool {
	for _, n := range needles {
		if len(n) == 0 {
			continue
		}
		for i := 0; i+len(n) <= len(s); i++ {
			if s[i:i+len(n)] == n {
				return true
			}
		}
	}
	return false
}
