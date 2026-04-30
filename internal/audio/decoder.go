// Package audio contains pure-Go decoders for the audio formats we can
// handle without shelling out to ffmpeg (MP3, FLAC, OGG Vorbis, WAV)
// plus PCM container utilities used by the media pipeline.
//
// Anything not covered by these native decoders is routed through the
// FFmpeg sidecar (see internal/ffmpeg).
package audio

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/hajimehoshi/go-mp3"
	"github.com/jfreymuth/oggvorbis"
	"github.com/mewkiz/flac"
)

// ErrNeedsFFmpeg is returned by DecodeTrack when the native decoders
// can't handle a format and the caller should fall back to ffmpeg.
// Kept sentinel-style so callers can detect it with errors.Is.
var ErrNeedsFFmpeg = errors.New("format requires ffmpeg")

// DecodeTrack picks a decoder based on file extension and returns
// (sampleRate, channels, interleaved-int16-PCM). It is intentionally
// forgiving: on any decoder error we bubble up a clear message so the
// frontend can surface it nicely.
//
// For formats we don't decode natively in Go (AAC, M4A, Opus, WMA,
// ALAC, etc.), callers should fall back to the FFmpeg sidecar.
func DecodeTrack(path string) (int, int, []int16, error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".mp3":
		return decodeMP3(path)
	case ".flac":
		return decodeFLAC(path)
	case ".ogg", ".oga":
		return decodeOggVorbis(path)
	case ".wav", ".wave":
		return decodeWAV(path)
	default:
		return 0, 0, nil, ErrNeedsFFmpeg
	}
}

// decodeMP3 uses hajimehoshi/go-mp3. Output is always stereo 16-bit PCM at
// the stream's native sample rate.
func decodeMP3(path string) (int, int, []int16, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, nil, err
	}
	defer f.Close()

	dec, err := mp3.NewDecoder(f)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("mp3: %w", err)
	}
	raw, err := io.ReadAll(dec)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("mp3 read: %w", err)
	}
	// go-mp3 emits little-endian 16-bit stereo samples.
	samples := make([]int16, len(raw)/2)
	for i := 0; i < len(samples); i++ {
		samples[i] = int16(binary.LittleEndian.Uint16(raw[i*2 : i*2+2]))
	}
	return dec.SampleRate(), 2, samples, nil
}

// decodeFLAC uses mewkiz/flac.
func decodeFLAC(path string) (int, int, []int16, error) {
	stream, err := flac.ParseFile(path)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("flac: %w", err)
	}
	defer stream.Close()

	sr := int(stream.Info.SampleRate)
	ch := int(stream.Info.NChannels)
	bps := int(stream.Info.BitsPerSample)
	if ch < 1 {
		return 0, 0, nil, errors.New("flac: zero channels")
	}

	// Estimate capacity so we don't keep reallocating.
	est := int(stream.Info.NSamples) * ch
	if est < 0 || est > 1<<28 { // safety bound
		est = 0
	}
	out := make([]int16, 0, est)

	for {
		frame, err := stream.ParseNext()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, 0, nil, fmt.Errorf("flac decode: %w", err)
		}

		// frame.Subframes is one per channel. Each sample is an int32 at
		// the stream's native bit depth; we downshift to int16.
		shift := bps - 16
		for i := 0; i < len(frame.Subframes[0].Samples); i++ {
			for c := 0; c < ch; c++ {
				s := frame.Subframes[c].Samples[i]
				var v int32
				if shift > 0 {
					v = s >> shift
				} else if shift < 0 {
					v = s << -shift
				} else {
					v = s
				}
				if v > 32767 {
					v = 32767
				} else if v < -32768 {
					v = -32768
				}
				out = append(out, int16(v))
			}
		}
	}
	return sr, ch, out, nil
}

// decodeOggVorbis uses jfreymuth/oggvorbis.
func decodeOggVorbis(path string) (int, int, []int16, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, nil, err
	}
	defer f.Close()

	reader, err := oggvorbis.NewReader(f)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("ogg: %w", err)
	}
	sr := reader.SampleRate()
	ch := reader.Channels()
	if ch < 1 {
		return 0, 0, nil, errors.New("ogg: zero channels")
	}

	buf := make([]float32, 8192*ch)
	out := make([]int16, 0, 1<<18)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			for i := 0; i < n; i++ {
				v := buf[i]
				if v > 1 {
					v = 1
				} else if v < -1 {
					v = -1
				}
				out = append(out, int16(math.Round(float64(v)*32767)))
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, 0, nil, fmt.Errorf("ogg read: %w", err)
		}
	}
	return sr, ch, out, nil
}

// decodeWAV reads a canonical RIFF/WAVE file. We only support PCM 16/24-bit
// and IEEE float 32-bit, which covers basically every consumer WAV.
func decodeWAV(path string) (int, int, []int16, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, nil, err
	}
	return DecodeWAVBytes(data)
}

// DecodeWAVBytes is the same as decodeWAV but operates on in-memory WAV
// bytes. Used when we pipe ffmpeg output through our WAV parser.
//
// Handles the common "streaming" quirk where ffmpeg writes 0xFFFFFFFF as
// the RIFF or `data` chunk size because the real size isn't known up
// front. When we see that sentinel we treat the chunk as running to the
// end of the buffer.
func DecodeWAVBytes(data []byte) (int, int, []int16, error) {
	if len(data) < 44 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return 0, 0, nil, errors.New("wav: not a RIFF/WAVE file")
	}

	var (
		fmtChunk []byte
		dataBuf  []byte
	)
	cursor := 12
	for cursor+8 <= len(data) {
		id := string(data[cursor : cursor+4])
		rawSize := binary.LittleEndian.Uint32(data[cursor+4 : cursor+8])
		body := cursor + 8

		size := int(rawSize)
		// Sentinel for "unknown / streamed" chunk size. In that case we
		// assume the chunk extends to the end of the buffer (or to the
		// next recognisable chunk, but for `data` there's usually nothing
		// after it anyway).
		if rawSize == 0xFFFFFFFF {
			size = len(data) - body
		}
		if size < 0 || body+size > len(data) {
			// Truncated — give up gracefully, keep whatever chunks we have.
			break
		}
		switch id {
		case "fmt ":
			fmtChunk = data[body : body+size]
		case "data":
			dataBuf = data[body : body+size]
		}
		cursor = body + size
		if size%2 == 1 {
			cursor++ // pad byte
		}
	}
	if fmtChunk == nil || dataBuf == nil {
		return 0, 0, nil, errors.New("wav: missing fmt or data chunk")
	}
	if len(fmtChunk) < 16 {
		return 0, 0, nil, errors.New("wav: fmt chunk too small")
	}
	format := binary.LittleEndian.Uint16(fmtChunk[0:2])
	ch := int(binary.LittleEndian.Uint16(fmtChunk[2:4]))
	sr := int(binary.LittleEndian.Uint32(fmtChunk[4:8]))
	bits := int(binary.LittleEndian.Uint16(fmtChunk[14:16]))

	switch format {
	case 1: // PCM
		switch bits {
		case 16:
			out := make([]int16, len(dataBuf)/2)
			for i := range out {
				out[i] = int16(binary.LittleEndian.Uint16(dataBuf[i*2 : i*2+2]))
			}
			return sr, ch, out, nil
		case 24:
			out := make([]int16, len(dataBuf)/3)
			for i := range out {
				b := dataBuf[i*3 : i*3+3]
				v := int32(b[0]) | int32(b[1])<<8 | int32(b[2])<<16
				if v&0x00800000 != 0 {
					v |= ^0x00FFFFFF // sign extend
				}
				out[i] = int16(v >> 8)
			}
			return sr, ch, out, nil
		case 8:
			out := make([]int16, len(dataBuf))
			for i := range out {
				// 8-bit WAV is unsigned
				out[i] = int16(int32(dataBuf[i])-128) * 256
			}
			return sr, ch, out, nil
		default:
			return 0, 0, nil, fmt.Errorf("wav: unsupported PCM bit depth %d", bits)
		}
	case 3: // IEEE float
		if bits != 32 {
			return 0, 0, nil, fmt.Errorf("wav: unsupported float bit depth %d", bits)
		}
		out := make([]int16, len(dataBuf)/4)
		for i := range out {
			bits := binary.LittleEndian.Uint32(dataBuf[i*4 : i*4+4])
			f := math.Float32frombits(bits)
			if f > 1 {
				f = 1
			} else if f < -1 {
				f = -1
			}
			out[i] = int16(math.Round(float64(f) * 32767))
		}
		return sr, ch, out, nil
	case 0xFFFE: // WAVE_FORMAT_EXTENSIBLE — peek at the SubFormat GUID
		if len(fmtChunk) < 40 {
			return 0, 0, nil, errors.New("wav: extensible fmt too small")
		}
		sub := fmtChunk[24:40]
		// First two bytes of the GUID = actual format code
		actual := binary.LittleEndian.Uint16(sub[0:2])
		// Recurse as if it were that format by rewriting fmt bytes.
		fmtChunk[0] = byte(actual)
		fmtChunk[1] = byte(actual >> 8)
		if actual == 1 || actual == 3 {
			// Rerun the switch — build a minimal replayable chunk.
			cp := make([]byte, len(fmtChunk))
			copy(cp, fmtChunk)
			return decodeWAVFmt(cp, dataBuf)
		}
		return 0, 0, nil, fmt.Errorf("wav: unsupported extensible subformat 0x%s", hex.EncodeToString(sub[0:2]))
	default:
		return 0, 0, nil, fmt.Errorf("wav: unsupported format code %d", format)
	}
}

// decodeWAVFmt is a small helper so the extensible branch can re-enter.
func decodeWAVFmt(fmtChunk, dataBuf []byte) (int, int, []int16, error) {
	format := binary.LittleEndian.Uint16(fmtChunk[0:2])
	ch := int(binary.LittleEndian.Uint16(fmtChunk[2:4]))
	sr := int(binary.LittleEndian.Uint32(fmtChunk[4:8]))
	bits := int(binary.LittleEndian.Uint16(fmtChunk[14:16]))
	switch format {
	case 1:
		if bits == 16 {
			out := make([]int16, len(dataBuf)/2)
			for i := range out {
				out[i] = int16(binary.LittleEndian.Uint16(dataBuf[i*2 : i*2+2]))
			}
			return sr, ch, out, nil
		}
	case 3:
		if bits == 32 {
			out := make([]int16, len(dataBuf)/4)
			for i := range out {
				b := binary.LittleEndian.Uint32(dataBuf[i*4 : i*4+4])
				f := math.Float32frombits(b)
				if f > 1 {
					f = 1
				} else if f < -1 {
					f = -1
				}
				out[i] = int16(math.Round(float64(f) * 32767))
			}
			return sr, ch, out, nil
		}
	}
	return 0, 0, nil, fmt.Errorf("wav: extensible %d/%d not supported", format, bits)
}
