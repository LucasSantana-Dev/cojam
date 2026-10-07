package main

import (
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
