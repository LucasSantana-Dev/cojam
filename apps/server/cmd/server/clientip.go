package main

import (
	"context"
	"net"
	"net/http"
	"strings"
)

// callerKey is the client IP used to key every IP-based limiter (report,
// telemetry, Spotify custody, connection token). Production traffic arrives
// Cloudflare Tunnel -> Caddy -> server, so the TCP peer is the proxy on a
// private or loopback address and the client is in CF-Connecting-IP, which
// Cloudflare sets and overwrites. The header is trusted only from such a
// peer: a request reaching the server directly from a public address keys on
// that address, so the header cannot be spoofed to dodge a limit.
// X-Forwarded-For is never read: its first entry is client-supplied.
func callerKey(r *http.Request) string {
	peer := r.RemoteAddr
	if host, _, err := net.SplitHostPort(peer); err == nil {
		peer = host
	}
	if ip := net.ParseIP(peer); ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		if cf := net.ParseIP(strings.TrimSpace(r.Header.Get("CF-Connecting-IP"))); cf != nil {
			return cf.String()
		}
	}
	return peer
}

// clientIPKey is the context key for the websocket upgrade's client IP.
type clientIPKey struct{}

// withClientIP stores callerKey(r) in the request context. centrifuge derives
// each connection's context from the upgrade request, so OnConnect can hand
// the IP to the hub (room creation budget per IP).
func withClientIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), clientIPKey{}, callerKey(r))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// clientIPFromContext returns the IP stored by withClientIP, or "".
func clientIPFromContext(ctx context.Context) string {
	ip, _ := ctx.Value(clientIPKey{}).(string)
	return ip
}
