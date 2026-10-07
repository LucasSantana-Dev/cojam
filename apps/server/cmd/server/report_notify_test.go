package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/report"
)

type fakeNotifier struct {
	got []report.Report
	cat []string
}

func (f *fakeNotifier) Notify(r report.Report, category string) {
	f.got = append(f.got, r)
	f.cat = append(f.cat, category)
}

// A notifier is told once, after the report is stored, with a known category.
func TestReport_NotifiesAfterStore(t *testing.T) {
	store := report.NewMemory()
	n := &fakeNotifier{}
	h := reportHandler(store, testRoomSecret, obs.New(), quietLogger(),
		newCallerLimiter(reportBurst, reportRefill), n)

	rec := postReport(h, `{"roomId":"R1","kind":"room","category":"minor_at_risk","reason":"x"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if len(n.got) != 1 || n.cat[0] != report.CategoryMinorAtRisk || n.got[0].RoomID != "R1" {
		t.Fatalf("unexpected notifications %+v %v", n.got, n.cat)
	}
	stored, _ := store.Recent(context.Background(), 1)
	if !strings.HasPrefix(stored[0].Reason, "[minor_at_risk]") {
		t.Fatalf("category should be recorded with the report, got %q", stored[0].Reason)
	}
}

// A dead webhook must not turn a stored report into an error.
func TestReport_DeadWebhookDoesNotFailTheReport(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	url := dead.URL
	dead.Close() // connection refused from here on

	wh, err := report.NewWebhookNotifier(url, quietLogger())
	if err != nil {
		t.Fatal(err)
	}
	store := report.NewMemory()
	h := reportHandler(store, testRoomSecret, obs.New(), quietLogger(),
		newCallerLimiter(reportBurst, reportRefill), wh)

	if rec := postReport(h, `{"roomId":"R1","kind":"room"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 with a dead webhook, got %d", rec.Code)
	}
	if got, _ := store.Recent(context.Background(), 5); len(got) != 1 {
		t.Fatalf("report must be stored regardless, got %d", len(got))
	}
}

// A rejected request never reaches the notifier.
func TestReport_NoNotificationOnReject(t *testing.T) {
	n := &fakeNotifier{}
	h := reportHandler(report.NewMemory(), testRoomSecret, obs.New(), quietLogger(),
		newCallerLimiter(reportBurst, reportRefill), n)
	postReport(h, `{"roomId":"R1","kind":"bogus"}`)
	if len(n.got) != 0 {
		t.Fatal("rejected report must not notify")
	}
}

// Body cap: an oversized body is rejected rather than stored or buffered whole.
func TestReport_OversizedBodyRejected(t *testing.T) {
	h, store := reportSetup(t)
	body := `{"roomId":"R1","kind":"room","content":"` + strings.Repeat("a", reportMaxBody+1024) + `"}`
	if rec := postReport(h, body); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an oversized body, got %d", rec.Code)
	}
	if got, _ := store.Recent(context.Background(), 1); len(got) != 0 {
		t.Fatal("oversized report must not be stored")
	}
}

func TestReport_BadIDsRejected(t *testing.T) {
	h, store := reportSetup(t)
	long := strings.Repeat("x", 129)
	for _, body := range []string{
		`{"roomId":"@everyone\n[x](http://evil)","kind":"room"}`,
		`{"roomId":"R1 R2","kind":"room"}`,
		`{"roomId":"` + long + `","kind":"room"}`,
		`{"roomId":"R1","kind":"member","subjectId":"` + long + `"}`,
		`{"roomId":"R1","kind":"member","subjectId":"<@&123>"}`,
	} {
		if rec := postReport(h, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d", body, rec.Code)
		}
	}
	if got, _ := store.Recent(context.Background(), 1); len(got) != 0 {
		t.Fatal("rejected reports must not be stored")
	}
	h, _ = reportSetup(t) // fresh limiter: the bad-id requests spent the burst
	if rec := postReport(h, `{"roomId":"AB12CD34","kind":"member","subjectId":"a1b2-c3_d4"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("real-shaped ids must pass, got %d", rec.Code)
	}
}

// Postgres text columns reject NUL; it must be stripped, not become a 500.
func TestReport_StripsNUL(t *testing.T) {
	h, store := reportSetup(t)
	rec := postReport(h, `{"roomId":"R1","kind":"message","content":"a\u0000b","reason":"c\u0000d"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	got, _ := store.Recent(context.Background(), 1)
	if got[0].Content != "ab" || got[0].Reason != "cd" {
		t.Fatalf("NUL not stripped: %+v", got[0])
	}
}

// reason shares the rune-safe truncation with content (#185), including when
// the category prefix is added.
func TestReport_ReasonTruncatesRuneSafe(t *testing.T) {
	h, store := reportSetup(t)
	long := strings.Repeat("ã", reportMaxReason+50)
	postReport(h, `{"roomId":"R1","kind":"room","category":"harassment","reason":"`+long+`"}`)
	got, _ := store.Recent(context.Background(), 1)
	if n := strings.Count(got[0].Reason, "ã"); n != reportMaxReason {
		t.Fatalf("expected %d runes of reason, got %d", reportMaxReason, n)
	}
	if strings.ContainsRune(got[0].Reason, '�') {
		t.Fatal("truncation split a rune")
	}
}

// Rate limiting is per caller: one flooder does not lock out another.
func TestReport_RateLimitIsPerCaller(t *testing.T) {
	h, _ := reportSetup(t)
	send := func(ip string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/report",
			strings.NewReader(`{"roomId":"R1","kind":"room"}`))
		req.RemoteAddr = ip + ":4000" // callerKey ignores spoofable headers from public peers
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}
	for i := 0; i < reportBurst*3; i++ {
		send("203.0.113.1")
	}
	if send("203.0.113.1") != http.StatusTooManyRequests {
		t.Fatal("flooder should be limited")
	}
	if send("203.0.113.2") != http.StatusNoContent {
		t.Fatal("a different caller must not share the budget")
	}
}

// The category prefix must not eat the reporter's reason budget.
func TestReport_PrefixDoesNotEatReason(t *testing.T) {
	h, store := reportSetup(t)
	reason := strings.Repeat("r", reportMaxReason)
	postReport(h, `{"roomId":"R1","kind":"room","category":"spam","reason":"`+reason+`"}`)
	got, _ := store.Recent(context.Background(), 1)
	if !strings.HasSuffix(got[0].Reason, reason) {
		t.Fatalf("reason was truncated by the prefix: %q", got[0].Reason)
	}
}
