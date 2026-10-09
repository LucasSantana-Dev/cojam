package main

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// accessLog is the HTTP access log: one structured line per request with the
// method, path, status and duration. It replaces chi's middleware.Logger,
// which records the full RequestURI and the client address. The query string
// is omitted because it can carry credentials (the deprecated
// connection-token form sends one). The client address is omitted too: the
// rate limiters key on it in memory, and nothing needs it persisted per
// request, so access logs stay free of personal data. request_id (from the
// requestID middleware, via the logger's context handler) correlates a line
// with the X-Request-Id the client saw.
func accessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// The wrapper keeps http.Hijacker/Flusher, so websocket upgrades
			// on /connection/websocket still work through it.
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			defer func() {
				status := ww.Status()
				if status == 0 && isUpgrade(r) {
					// Hijacked by the websocket handler: the connection was
					// switched, and the handler returned only when the session
					// ended, so its duration is not a request latency.
					logger.InfoContext(r.Context(), "http_request",
						"method", r.Method,
						"path", r.URL.Path,
						"status", http.StatusSwitchingProtocols,
					)
					return
				}
				if status == 0 {
					status = http.StatusOK
				}
				logger.InfoContext(r.Context(), "http_request",
					"method", r.Method,
					"path", r.URL.Path,
					"status", status,
					"duration_ms", float64(time.Since(start).Microseconds())/1000.0,
				)
			}()
			next.ServeHTTP(ww, r)
		})
	}
}

// isUpgrade reports a websocket upgrade request.
func isUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}
