package httpx

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type rtFunc func(*http.Request) (*http.Response, error)

func (f rtFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type rec struct{ provider, op, status string }

func run(t *testing.T, url, op string, rt rtFunc) (rec, *http.Response, error) {
	t.Helper()
	var got rec
	SetObserver(func(p, o, s string, _ time.Duration) { got = rec{p, o, s} })
	t.Cleanup(func() { SetObserver(nil) })
	req, _ := http.NewRequestWithContext(WithOp(context.Background(), op), "GET", url, nil)
	resp, err := Instrument(rt).RoundTrip(req)
	return got, resp, err
}

func reply(code int, body string) rtFunc {
	return func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
}

func TestInstrumentStatusMapping(t *testing.T) {
	const yt = "https://www.googleapis.com/youtube/v3/search"
	cases := []struct {
		name, url string
		rt        rtFunc
		want      rec
	}{
		{"youtube ok", yt, reply(200, "{}"), rec{"youtube", "search", "ok"}},
		{"youtube quota", yt, reply(403, `{"error":{"errors":[{"reason":"quotaExceeded"}]}}`), rec{"youtube", "search", "quota"}},
		{"youtube rate limit reason", yt, reply(403, `{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}`), rec{"youtube", "search", "ratelimit"}},
		{"youtube bad key is error", yt, reply(403, `{"error":{"errors":[{"reason":"forbidden"}]}}`), rec{"youtube", "search", "error"}},
		{"429 is ratelimit", "https://api.spotify.com/v1/search", reply(429, ""), rec{"spotify", "search", "ratelimit"}},
		{"500 is error", "https://api.deezer.com/search", reply(500, ""), rec{"deezer", "search", "error"}},
		{"lyrics host", "https://lrclib.net/api/get", reply(200, "{}"), rec{"lyrics", "search", "ok"}},
		{"unknown host is other", "https://example.org/x", reply(200, "{}"), rec{"other", "search", "ok"}},
		{"deadline is timeout", "https://api.deezer.com/search", func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded }, rec{"deezer", "search", "timeout"}},
		{"other failure is error", "https://api.deezer.com/search", func(*http.Request) (*http.Response, error) { return nil, errors.New("dial refused") }, rec{"deezer", "search", "error"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, _, _ := run(t, c.url, "search", c.rt)
			if got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestInstrumentKeepsBodyReadableAfterPeek(t *testing.T) {
	body := `{"error":{"errors":[{"reason":"quotaExceeded"}]}}`
	_, resp, _ := run(t, "https://www.googleapis.com/youtube/v3/search", "search", reply(403, body))
	b, _ := io.ReadAll(resp.Body)
	if string(b) != body {
		t.Fatalf("body = %q, want it intact", b)
	}
}

func TestOpDefaultsToOther(t *testing.T) {
	var got rec
	SetObserver(func(p, o, s string, _ time.Duration) { got = rec{p, o, s} })
	t.Cleanup(func() { SetObserver(nil) })
	req, _ := http.NewRequest("GET", "https://api.deezer.com/x", nil)
	_, _ = Instrument(reply(200, "")).RoundTrip(req)
	if got.op != "other" {
		t.Fatalf("op = %q, want other", got.op)
	}
}

func TestDoJSONErrorOmitsURL(t *testing.T) {
	req, _ := http.NewRequestWithContext(context.Background(), "GET", "http://127.0.0.1:1/search?q=secret-song-title", nil)
	var v any
	err := DoJSON(req, &v)
	if err == nil || strings.Contains(err.Error(), "secret-song-title") {
		t.Fatalf("error must not carry the URL: %v", err)
	}
}
