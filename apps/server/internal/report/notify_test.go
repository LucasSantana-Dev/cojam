package report

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func testReport() Report {
	return Report{
		ID: "rep-1", RoomID: "ROOM12345678", Kind: KindMessage,
		ReporterSub: "sub-secret", SubjectID: "m-9",
		Content: "private chat content", Reason: "free text reason",
		CreatedAt: time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC),
	}
}

func TestNewWebhookNotifier_OffWhenUnset(t *testing.T) {
	n, err := NewWebhookNotifier("", nil)
	if err != nil || n != nil {
		t.Fatalf("empty URL must disable the webhook, got %v, %v", n, err)
	}
}

func TestNewWebhookNotifier_RejectsBadURL(t *testing.T) {
	for _, u := range []string{"not a url", "ftp://example.com/x", "http://", "/relative"} {
		if n, err := NewWebhookNotifier(u, nil); err == nil || n != nil {
			t.Errorf("%q: expected an error", u)
		}
	}
}

// The payload is the privacy contract: no chat content, no reporter identity,
// no free text, no subject id.
func TestWebhook_PostsMinimalSummary(t *testing.T) {
	got := make(chan []byte, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content type %q", ct)
		}
		got <- b
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	n, err := NewWebhookNotifier(srv.URL, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	n.Notify(testReport(), CategoryMinorAtRisk)

	select {
	case body := <-got:
		var p WebhookPayload
		if err := json.Unmarshal(body, &p); err != nil {
			t.Fatalf("bad json: %v", err)
		}
		if p.ReportID != "rep-1" || p.Kind != "message" || p.RoomID != "ROOM12345678" ||
			p.Category != CategoryMinorAtRisk || p.CreatedAt != "2026-10-07T12:00:00Z" {
			t.Fatalf("unexpected payload %+v", p)
		}
		if !strings.Contains(string(body), `"allowed_mentions":{"parse":[]}`) {
			t.Errorf("allowed_mentions missing: %s", body)
		}
		if !strings.Contains(p.Text, "`ROOM12345678`") {
			t.Errorf("room id should sit in a code span: %q", p.Text)
		}
		for _, banned := range []string{"private chat content", "free text reason", "sub-secret", "m-9"} {
			if strings.Contains(string(body), banned) {
				t.Errorf("payload leaked %q: %s", banned, body)
			}
		}
	case <-time.After(3 * time.Second):
		t.Fatal("webhook was not called")
	}
}

func TestWebhook_UnknownCategoryCollapsesToOther(t *testing.T) {
	got := make(chan WebhookPayload, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p WebhookPayload
		_ = json.NewDecoder(r.Body).Decode(&p)
		got <- p
	}))
	defer srv.Close()
	n, _ := NewWebhookNotifier(srv.URL, nil)
	n.Notify(testReport(), "<script>alert(1)</script>")
	select {
	case p := <-got:
		if p.Category != CategoryOther {
			t.Fatalf("category %q", p.Category)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("webhook was not called")
	}
}

// A failing endpoint is logged and never panics or blocks the caller.
func TestWebhook_FailureIsLoggedNotFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	url := srv.URL
	logs := &lockedBuf{}
	n, _ := NewWebhookNotifier(url, slog.New(slog.NewTextHandler(logs, nil)))

	start := time.Now()
	n.Notify(testReport(), CategoryOther)
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("Notify blocked the caller")
	}
	waitFor(t, func() bool { return strings.Contains(logs.String(), "report_webhook_failed") })
	if strings.Contains(logs.String(), url) {
		t.Fatal("the webhook URL must not be logged")
	}
	srv.Close()

	// Connection refused takes the transport error path.
	logs2 := &lockedBuf{}
	n2, _ := NewWebhookNotifier(url, slog.New(slog.NewTextHandler(logs2, nil)))
	n2.Notify(testReport(), CategoryOther)
	waitFor(t, func() bool { return strings.Contains(logs2.String(), "report_webhook_failed") })
	if strings.Contains(logs2.String(), url) {
		t.Fatal("the webhook URL must not be logged on transport errors")
	}
}

// A hung endpoint is cut off by the timeout and does not leak in-flight slots.
func TestWebhook_SlowEndpointDoesNotBlockCaller(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	n, _ := NewWebhookNotifier(srv.URL, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	start := time.Now()
	for i := 0; i < webhookInflight*3; i++ {
		n.Notify(testReport(), CategoryOther) // beyond the cap, extras are dropped
	}
	if time.Since(start) > time.Second {
		t.Fatal("Notify blocked on a hung endpoint")
	}
}

type lockedBuf struct {
	mu sync.Mutex
	sb strings.Builder
}

func (b *lockedBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.Write(p)
}

func (b *lockedBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.String()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestSafeInline_StripsBreakouts(t *testing.T) {
	if got := safeInline("a`b\nc\x00@everyone"); got != "abc@everyone" {
		t.Fatalf("got %q", got)
	}
}
