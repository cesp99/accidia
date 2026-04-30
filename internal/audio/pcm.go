package audio

import (
	"bytes"
	"encoding/binary"
)

// PCMToLittleEndianBytes serialises an int16 slice as interleaved little-
// endian bytes, the same layout as the "data" chunk in a WAV file. We
// return a new byte slice so the caller owns the memory.
func PCMToLittleEndianBytes(samples []int16) []byte {
	out := make([]byte, len(samples)*2)
	for i, s := range samples {
		out[i*2] = byte(uint16(s))
		out[i*2+1] = byte(uint16(s) >> 8)
	}
	return out
}

// WrapAsWAV takes interleaved 16-bit PCM samples and wraps them in a
// minimal RIFF/WAVE container. The output is a valid WAV file ready to
// be decoded by `AudioContext.decodeAudioData` in any webview.
func WrapAsWAV(sr, ch int, samples []int16) []byte {
	byteRate := sr * ch * 2
	blockAlign := ch * 2
	dataSize := len(samples) * 2

	out := bytes.NewBuffer(make([]byte, 0, dataSize+44))
	// RIFF header
	out.WriteString("RIFF")
	binary.Write(out, binary.LittleEndian, uint32(36+dataSize))
	out.WriteString("WAVE")
	// fmt chunk
	out.WriteString("fmt ")
	binary.Write(out, binary.LittleEndian, uint32(16))  // PCM chunk size
	binary.Write(out, binary.LittleEndian, uint16(1))   // PCM format
	binary.Write(out, binary.LittleEndian, uint16(ch))  //
	binary.Write(out, binary.LittleEndian, uint32(sr))  //
	binary.Write(out, binary.LittleEndian, uint32(byteRate))
	binary.Write(out, binary.LittleEndian, uint16(blockAlign))
	binary.Write(out, binary.LittleEndian, uint16(16)) // bits per sample
	// data chunk
	out.WriteString("data")
	binary.Write(out, binary.LittleEndian, uint32(dataSize))
	// Samples are little-endian int16.
	tmp := make([]byte, 2)
	for _, s := range samples {
		binary.LittleEndian.PutUint16(tmp, uint16(s))
		out.Write(tmp)
	}
	return out.Bytes()
}
