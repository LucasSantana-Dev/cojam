// Package httpx provides the shared outbound HTTP client for third-party music
// APIs (Spotify, Deezer, YouTube, Tidal, Last.fm, MusicBrainz). It exists so a
// slow or hostile upstream cannot hang a request goroutine indefinitely and so
// a malicious response cannot exhaust memory during decode.
package httpx

import (
	"net"
	"net/http"
	"time"
)

// Client is the shared client. Timeouts bound every stage of an outbound call:
// an overall deadline plus dial, TLS-handshake, and response-header sub-limits.
var Client = &http.Client{
	Timeout: 8 * time.Second,
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   3 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   3 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
	},
}

// MaxResponseBytes caps how much of an upstream response body we read or decode,
// so a giant (or hostile) response cannot exhaust server memory.
const MaxResponseBytes int64 = 10 << 20 // 10 MiB
