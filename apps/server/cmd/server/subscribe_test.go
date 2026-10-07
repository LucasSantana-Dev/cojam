package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
)

// Only "room:<valid id>" channels may be subscribed; anything else is refused
// without enrolment, so clients cannot open arbitrary channels with presence.
func TestAuthorizeSubscribe(t *testing.T) {
	h := hub.NewHub(nil)

	for _, ch := range []string{"room:abc", "room:", "room:TOO_LONG_ROOM_ID", "news", "$admin", "room:AB:CD"} {
		if _, err := authorizeSubscribe(h, "c1", ch); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
			t.Fatalf("subscribe %q: got %v, want ErrorPermissionDenied", ch, err)
		}
	}

	reply, err := authorizeSubscribe(h, "c1", "room:ABC123")
	if err != nil {
		t.Fatalf("valid subscribe: %v", err)
	}
	if !reply.Options.EmitPresence || !reply.Options.EmitJoinLeave || !reply.Options.PushJoinLeave {
		t.Fatalf("room subscriptions must keep presence and join/leave: %+v", reply.Options)
	}
	if !h.IsMember("c1", "ABC123") {
		t.Fatal("a room subscription must enrol the client")
	}
}

// The websocket upgrade request's client IP (same trust rules as callerKey)
// is carried in the connection context for the hub to record.
func TestWithClientIP_StoresCallerKeyInContext(t *testing.T) {
	var got string
	h := withClientIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = clientIPFromContext(r.Context())
	}))
	req := httptest.NewRequest(http.MethodGet, "/connection/websocket", nil)
	req.RemoteAddr = "172.18.0.5:4000"
	req.Header.Set("CF-Connecting-IP", "203.0.113.5")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "203.0.113.5" {
		t.Fatalf("client IP = %q, want 203.0.113.5", got)
	}
	if ip := clientIPFromContext(context.Background()); ip != "" {
		t.Fatalf("empty context: got %q", ip)
	}
}
