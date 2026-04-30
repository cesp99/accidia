package mpris

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// ArtCacheKey derives a stable, short cache key from a (trackPath, data URL)
// pair. Only the first 256 chars of the data URL are hashed so we don't
// pointlessly hash megabytes of base64 on the hot path — the MIME prefix
// + a little of the payload is plenty to disambiguate different covers.
func ArtCacheKey(trackPath, artURL string) string {
	head := artURL
	if len(head) > 256 {
		head = head[:256]
	}
	sum := sha1.Sum([]byte(trackPath + "|" + head))
	return hex.EncodeToString(sum[:])
}

// WriteDataURLToCache parses a "data:<mime>;base64,<payload>" URL and
// writes the decoded bytes to <dir>/<key><ext>. Returns the absolute
// file path and true on success. Malformed or non-base64 URLs return
// ("", false) so callers can fall back to "no art".
//
// Extracted to its own helper so the MPRIS-art caching behaviour can be
// unit-tested without spinning up a whole App + D-Bus connection.
func WriteDataURLToCache(dataURL, dir, key string) (string, bool) {
	if !strings.HasPrefix(dataURL, "data:") {
		return "", false
	}
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 {
		return "", false
	}
	header := dataURL[5:comma]
	payload := dataURL[comma+1:]
	mime := header
	if idx := strings.IndexByte(header, ';'); idx >= 0 {
		mime = header[:idx]
	}
	if !strings.HasPrefix(header[len(mime):], ";base64") {
		// Non-base64 data URL — we don't support percent-encoded blobs;
		// they'd be unusual for cover art anyway.
		return "", false
	}
	bytes, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", false
	}
	filePath := filepath.Join(dir, key+ExtForMIME(mime))
	if err := os.WriteFile(filePath, bytes, 0o644); err != nil {
		return "", false
	}
	return filePath, true
}

// ExtForMIME maps a MIME type to a reasonable file extension. MPRIS
// clients don't inspect the extension, but a sensible one keeps the
// cache dir browseable.
func ExtForMIME(mime string) string {
	switch mime {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	}
	return ".bin"
}
