package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseLogLevel(t *testing.T) {
	cases := []struct {
		in   string
		want slog.Level
		ok   bool
	}{
		{"", slog.LevelInfo, true},
		{"debug", slog.LevelDebug, true},
		{"INFO", slog.LevelInfo, true},
		{" warn ", slog.LevelWarn, true},
		{"warning", slog.LevelWarn, true},
		{"error", slog.LevelError, true},
		{"verbose", slog.LevelInfo, false},
	}
	for _, c := range cases {
		got, ok := parseLogLevel(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("parseLogLevel(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestNewLoggerLevelAndBaseAttrs(t *testing.T) {
	var buf bytes.Buffer
	l := newLogger(&buf, slog.LevelWarn, "v1.2.3")
	l.Info("hidden")
	l.Warn("shown")
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("want only the warn line, got %q", buf.String())
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &rec); err != nil {
		t.Fatal(err)
	}
	if rec["service"] != "cojam-server" || rec["version"] != "v1.2.3" || rec["msg"] != "shown" {
		t.Fatalf("unexpected record %v", rec)
	}
}

func TestCtxHandlerAddsRequestID(t *testing.T) {
	var buf bytes.Buffer
	l := newLogger(&buf, slog.LevelInfo, "dev")
	ctx := context.WithValue(context.Background(), ctxKey{}, "abc12345")
	l.InfoContext(ctx, "with")
	l.Info("without")
	out := buf.String()
	if strings.Count(out, "request_id") != 1 || !strings.Contains(out, `"request_id":"abc12345"`) {
		t.Fatalf("request_id must appear only on the context line: %s", out)
	}
}

func TestRequestIDEchoedAndInAccessLog(t *testing.T) {
	var buf bytes.Buffer
	logger := newLogger(&buf, slog.LevelInfo, "dev")
	h := requestID(accessLog(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requestIDFrom(r.Context()) == "" {
			t.Error("handler context has no request id")
		}
		w.WriteHeader(http.StatusOK)
	})))

	// Generated when absent.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/rooms", nil))
	id := rec.Header().Get("X-Request-Id")
	if len(id) != 16 {
		t.Fatalf("generated id = %q", id)
	}
	if !strings.Contains(buf.String(), `"request_id":"`+id+`"`) {
		t.Fatalf("access log lacks request_id %s: %s", id, buf.String())
	}

	// A well formed caller id is kept; a hostile one is replaced.
	buf.Reset()
	req := httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
	req.Header.Set("X-Request-Id", "edge-req_0001")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); got != "edge-req_0001" {
		t.Fatalf("caller id not kept: %q", got)
	}

	buf.Reset()
	req = httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
	req.Header.Set("X-Request-Id", `x","level":"ERROR`)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); strings.Contains(got, `"`) || len(got) != 16 {
		t.Fatalf("hostile id not replaced: %q", got)
	}
}

// The centrifuge "client command error" entry carries the raw command (RPC
// payload with nicknames, URLs, room ids). Only allowlisted keys are logged;
// the method is parsed out of the command without keeping its data.
func TestCentrifugeFields_NoPayload(t *testing.T) {
	fields := map[string]any{
		"command": `id:7 rpc:{data:"{\"addedBy\":\"Maria\",\"url\":\"https://example.test/v\",\"roomId\":\"r1\"}" method:"queue.add"}`,
		"reply":   `id:7 error:{code:103 message:"bad request"}`,
		"user":    "u-123",
		"client":  "c-1",
		"code":    103,
		"error":   "bad request",
		"reason":  "x",
	}
	got := safeCentrifugeFields(fields)
	for _, k := range []string{"command", "reply", "user"} {
		if _, ok := got[k]; ok {
			t.Fatalf("field %q must not be logged: %v", k, got)
		}
	}
	if got["code"] != 103 || got["client"] != "c-1" || got["error"] != "bad request" || got["reason"] != "x" {
		t.Fatalf("allowlisted fields lost: %v", got)
	}
	if got["method"] != "queue.add" {
		t.Fatalf("method = %v, want queue.add", got["method"])
	}
	line := fmt.Sprint(got)
	for _, leaked := range []string{"Maria", "example.test", "r1", "addedBy"} {
		if strings.Contains(line, leaked) {
			t.Fatalf("payload leaked %q: %s", leaked, line)
		}
	}
}

func TestCentrifugeFields_MethodNotFromPayload(t *testing.T) {
	// A payload that mimics a method key is escaped inside data and must not match.
	got := safeCentrifugeFields(map[string]any{"command": `id:1 rpc:{data:"x method:\"evil\""}`})
	if _, ok := got["method"]; ok {
		t.Fatalf("method parsed from payload: %v", got)
	}
}
