// Package httpx provides the shared outbound HTTP client for third-party music
// APIs (Spotify, Deezer, YouTube, Last.fm, MusicBrainz). It exists so a
// slow or hostile upstream cannot hang a request goroutine indefinitely and so
// a malicious response cannot exhaust memory during decode.
package httpx

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// Client is the shared client. Timeouts bound every stage of an outbound call:
// an overall deadline plus dial, TLS-handshake, and response-header sub-limits.
var Client = &http.Client{
	Timeout: 8 * time.Second,
	Transport: Instrument(&http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   3 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   3 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
	}),
}

// MaxResponseBytes caps how much of an upstream response body we read or decode,
// so a giant (or hostile) response cannot exhaust server memory.
const MaxResponseBytes int64 = 10 << 20 // 10 MiB

// StatusError is returned by DoJSON for a non-2xx response, so callers can
// tell a genuine miss (404) from an outage without parsing the message.
//
// Body holds the first MaxErrorBodyBytes of the response body so a caller can
// read a machine-readable reason (YouTube's quotaExceeded). It is never part
// of Error(), so it cannot leak into logs or RPC errors by accident.
type StatusError struct {
	Code int
	Body []byte
}

// MaxErrorBodyBytes caps the error body kept on a StatusError.
const MaxErrorBodyBytes = 2048

func (e *StatusError) Error() string { return fmt.Sprintf("upstream status %d", e.Code) }

// DoJSON sends an HTTP request using Client.Do and decodes the response body
// as JSON into v. On any error, returns an error without leaking the response body.
// Status codes outside the 2xx range return a generic error without exposing the body.
func DoJSON(req *http.Request, v any) error {
	resp, err := Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		// Keep a small prefix for callers that need the reason, drain the rest
		// to avoid leaks; the body is not part of the error message.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, MaxErrorBodyBytes))
		io.Copy(io.Discard, io.LimitReader(resp.Body, MaxResponseBytes))
		return &StatusError{Code: resp.StatusCode, Body: body}
	}

	return json.NewDecoder(io.LimitReader(resp.Body, MaxResponseBytes)).Decode(v)
}
