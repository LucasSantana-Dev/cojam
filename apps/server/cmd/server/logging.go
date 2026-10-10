package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/centrifugal/centrifuge"
)

// parseLogLevel maps LOG_LEVEL (debug|info|warn|error, case-insensitive) to an
// slog level. Empty or unrecognized values give info and ok=false for the
// latter, so main can warn about a typo instead of silently running at info.
func parseLogLevel(raw string) (level slog.Level, ok bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return slog.LevelInfo, true
	case "debug":
		return slog.LevelDebug, true
	case "info":
		return slog.LevelInfo, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	}
	return slog.LevelInfo, false
}

// newLogger builds the process logger: JSON lines, level from LOG_LEVEL, base
// attributes service and version on every line, and request_id pulled from the
// context by the *Context methods.
func newLogger(w io.Writer, level slog.Level, ver string) *slog.Logger {
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})
	return slog.New(ctxHandler{base}).With("service", "cojam-server", "version", ver)
}

// fatal logs msg at error level and exits 1: log.Fatal semantics through slog,
// so a boot failure is one structured line like everything else.
func fatal(logger *slog.Logger, msg string, args ...any) {
	logger.Error(msg, args...)
	os.Exit(1)
}

type ctxKey struct{}

// requestIDFrom returns the request id carried by ctx, or "".
func requestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// ctxHandler adds request_id to records logged with a request context.
type ctxHandler struct{ slog.Handler }

func (h ctxHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := requestIDFrom(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h ctxHandler) WithAttrs(a []slog.Attr) slog.Handler { return ctxHandler{h.Handler.WithAttrs(a)} }
func (h ctxHandler) WithGroup(n string) slog.Handler      { return ctxHandler{h.Handler.WithGroup(n)} }

const requestIDHeader = "X-Request-Id"

// validRequestID accepts a caller-supplied id only when it is short and made of
// URL-safe characters: the value lands in log lines, so anything else could
// forge fields or blow up cardinality.
func validRequestID(s string) bool {
	if len(s) < 8 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// requestID assigns every HTTP request an id (the caller's X-Request-Id when
// well formed, else a random one), stores it in the context and echoes it in
// the response header. It carries no client address.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(requestIDHeader)
		if !validRequestID(id) {
			id = newRequestID()
		}
		w.Header().Set(requestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

// centrifugeLogLevel is the lowest centrifuge level worth emitting for the
// process level: centrifuge filters before the handler, so debug stays cheap.
func centrifugeLogLevel(l slog.Level) centrifuge.LogLevel {
	switch {
	case l <= slog.LevelDebug:
		return centrifuge.LogLevelDebug
	case l <= slog.LevelInfo:
		return centrifuge.LogLevelInfo
	case l <= slog.LevelWarn:
		return centrifuge.LogLevelWarn
	}
	return centrifuge.LogLevelError
}

// centrifugeSlogLevel maps a centrifuge entry level to the slog level, so its
// warnings and errors are no longer all flattened to info.
func centrifugeSlogLevel(l centrifuge.LogLevel) slog.Level {
	switch l {
	case centrifuge.LogLevelTrace, centrifuge.LogLevelDebug:
		return slog.LevelDebug
	case centrifuge.LogLevelWarn:
		return slog.LevelWarn
	case centrifuge.LogLevelError:
		return slog.LevelError
	}
	return slog.LevelInfo
}

// centrifugeFieldAllowlist is the set of centrifuge log field keys that are
// written. Anything else is dropped: "command" and "reply" carry the raw RPC
// payload (nicknames, URLs, room ids), and new upstream fields are not assumed
// safe.
var centrifugeFieldAllowlist = map[string]bool{
	"client": true,
	"code":   true,
	"reason": true,
	"error":  true,
	"method": true,
}

var commandMethodRe = regexp.MustCompile(`(?:^|[ {])method:"([a-z][a-z0-9_.]{0,63})"`)

// safeCentrifugeFields returns the allowlisted fields plus, when the entry has
// a "command", its RPC method name parsed out of it without keeping any data.
func safeCentrifugeFields(fields map[string]any) map[string]any {
	out := make(map[string]any, len(fields))
	for k, v := range fields {
		if centrifugeFieldAllowlist[k] {
			out[k] = v
		}
	}
	if _, ok := out["method"]; !ok {
		if cmd, ok := fields["command"].(string); ok {
			if m := commandMethodRe.FindStringSubmatch(cmd); m != nil {
				out["method"] = m[1]
			}
		}
	}
	return out
}
