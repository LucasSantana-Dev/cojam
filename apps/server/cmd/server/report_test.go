package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/report"
)

func reportSetup(t *testing.T) (http.HandlerFunc, *report.Memory) {
	t.Helper()
	store := report.NewMemory()
	h := reportHandler(store, testRoomSecret, obs.New(), quietLogger(),
		newCallerLimiter(reportBurst, reportRefill))
	return h, store
}

func postReport(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/report", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

// The report copies the content, because the chat line it concerns is usually
// gone by the time anyone reads it (ADR-0006, docs/specs/259).
func TestReport_CopiesTheContent(t *testing.T) {
	h, store := reportSetup(t)

	rec := postReport(h, `{"roomId":"R1","kind":"message","subjectId":"m-1","content":"the reported line","reason":"abuse","connToken":"`+testConnToken(t, "sub-1")+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}

	got, err := store.Recent(context.Background(), 10)
	if err != nil || len(got) != 1 {
		t.Fatalf("expected one report, got %d, %v", len(got), err)
	}
	if got[0].Content != "the reported line" {
		t.Fatalf("the report did not copy the content, got %q", got[0].Content)
	}
	if got[0].ReporterSub != "sub-1" {
		t.Fatalf("expected the reporter identity recorded, got %q", got[0].ReporterSub)
	}
}

// Reporting must work for guests: requiring an account would exclude most of
// the people it exists to protect.
func TestReport_AcceptsWithoutIdentity(t *testing.T) {
	h, store := reportSetup(t)

	rec := postReport(h, `{"roomId":"R1","kind":"room","reason":"strangers being abusive"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 without a connToken, got %d", rec.Code)
	}
	got, _ := store.Recent(context.Background(), 10)
	if len(got) != 1 || got[0].ReporterSub != "" {
		t.Fatalf("expected an anonymous report to be stored, got %+v", got)
	}
}

// kind reaches a CHECK-constrained column, so an arbitrary string must not
// get that far.
func TestReport_RejectsBadInput(t *testing.T) {
	h, _ := reportSetup(t)

	for _, body := range []string{
		`{"roomId":"R1","kind":"nonsense"}`,
		`{"roomId":"R1"}`,
		`{"kind":"message","subjectId":"m-1"}`,
		`{"roomId":`,
	} {
		if rec := postReport(h, body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: expected 400, got %d", body, rec.Code)
		}
	}
}

// Byte slicing would split a multi-byte rune (#185).
func TestReport_TruncatesRuneSafe(t *testing.T) {
	h, store := reportSetup(t)
	long := strings.Repeat("é", reportMaxContent+200)

	if rec := postReport(h, `{"roomId":"R1","kind":"message","content":"`+long+`"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	got, _ := store.Recent(context.Background(), 1)
	if n := len([]rune(got[0].Content)); n != reportMaxContent {
		t.Fatalf("expected %d runes, got %d", reportMaxContent, n)
	}
	if strings.ContainsRune(got[0].Content, '�') {
		t.Fatal("truncation split a rune")
	}
}

func TestReport_RateLimited(t *testing.T) {
	h, _ := reportSetup(t)
	body := `{"roomId":"R1","kind":"room","reason":"x"}`

	var limited bool
	for i := 0; i < reportBurst*4; i++ {
		if postReport(h, body).Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("expected the limiter to reject a flood")
	}
}

func TestReportStore_MemoryReturnsNewestFirst(t *testing.T) {
	ctx := context.Background()
	m := report.NewMemory()
	for _, id := range []string{"a", "b", "c"} {
		if err := m.Create(ctx, report.Report{ID: id, RoomID: "R1", Kind: report.KindRoom, CreatedAt: time.Now()}); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}
	got, err := m.Recent(ctx, 2)
	if err != nil || len(got) != 2 {
		t.Fatalf("Recent: %d, %v", len(got), err)
	}
	if got[0].ID != "c" || got[1].ID != "b" {
		t.Fatalf("expected newest first, got %s then %s", got[0].ID, got[1].ID)
	}
}

func TestReportStore_RejectsInvalidKind(t *testing.T) {
	err := report.NewMemory().Create(context.Background(), report.Report{ID: "x", Kind: report.Kind("bogus")})
	if err == nil {
		t.Fatal("expected an invalid kind to be rejected at the store")
	}
}
