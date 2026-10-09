package httpx

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

type opKey struct{}

// WithOp names the operation of the outbound calls made with the returned
// context (search, lookup, playlist, token, lyrics, similar, isrc, jwks). It
// is a bounded label on the provider metrics; unknown values are clamped to
// "other" by the observer. Without it the op is "other".
func WithOp(ctx context.Context, op string) context.Context {
	return context.WithValue(ctx, opKey{}, op)
}

func opFrom(ctx context.Context) string {
	if op, ok := ctx.Value(opKey{}).(string); ok && op != "" {
		return op
	}
	return "other"
}

// Observer receives one record per outbound call. provider and status are
// bounded enums (see obs.Providers, obs.ProviderStatuses).
type Observer func(provider, op, status string, d time.Duration)

var observer atomic.Pointer[Observer]

// SetObserver installs the outbound-call observer on the shared Client. Call
// it once at boot; nil removes it.
func SetObserver(o Observer) {
	if o == nil {
		observer.Store(nil)
		return
	}
	observer.Store(&o)
}

// ProviderFor maps an outbound host to a provider label. The set is closed:
// an unknown host is "other", never the host string itself.
func ProviderFor(host string) string {
	host = strings.ToLower(host)
	switch {
	case strings.HasSuffix(host, "googleapis.com"), strings.HasSuffix(host, "youtube.com"):
		return "youtube"
	case strings.HasSuffix(host, "spotify.com"):
		return "spotify"
	case strings.HasSuffix(host, "deezer.com"):
		return "deezer"
	case strings.HasSuffix(host, "lrclib.net"):
		return "lyrics"
	}
	return "other"
}

// instrumented wraps a RoundTripper and reports every call to the observer.
type instrumented struct{ next http.RoundTripper }

// Instrument wraps rt so each call is reported to the observer set with SetObserver.
func Instrument(rt http.RoundTripper) http.RoundTripper { return instrumented{next: rt} }

func (t instrumented) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	resp, err := t.next.RoundTrip(req)
	o := observer.Load()
	if o == nil {
		return resp, err
	}
	provider := ProviderFor(req.URL.Hostname())
	status := "ok"
	switch {
	case err != nil:
		status = "error"
		var ne net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
			status = "timeout"
		}
	default:
		status = classifyStatus(provider, resp)
	}
	(*o)(provider, opFrom(req.Context()), status, time.Since(start))
	return resp, err
}

// classifyStatus maps a response to ok|error|quota|ratelimit. Only YouTube's
// 403 needs the body: quotaExceeded is a 403, a bad key is also a 403. The
// peeked prefix is put back so the caller still reads the whole body.
func classifyStatus(provider string, resp *http.Response) string {
	code := resp.StatusCode
	switch {
	case code < 400:
		return "ok"
	case code == http.StatusTooManyRequests:
		return "ratelimit"
	case code == http.StatusForbidden && provider == "youtube" && resp.Body != nil:
		head, _ := io.ReadAll(io.LimitReader(resp.Body, MaxErrorBodyBytes))
		resp.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(head), resp.Body), resp.Body}
		s := string(head)
		switch {
		case strings.Contains(s, "quotaExceeded"), strings.Contains(s, "dailyLimitExceeded"):
			return "quota"
		case strings.Contains(s, "rateLimitExceeded"):
			return "ratelimit"
		}
	}
	return "error"
}
