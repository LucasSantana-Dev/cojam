package main

import (
	"net/http"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/events"
)

func TestEventsEnabledFlag(t *testing.T) {
	cases := []struct {
		name   string
		env    map[string]string
		haveDB bool
		want   bool
	}{
		{"default with a database is on", nil, true, true},
		{"in-memory mode is off", nil, false, false},
		{"explicit off wins", map[string]string{"FEATURE_PRODUCT_EVENTS": "false"}, true, false},
		{"explicit on without a database still has no table", map[string]string{"FEATURE_PRODUCT_EVENTS": "true"}, false, false},
	}
	for _, c := range cases {
		if got := eventsEnabled(envOf(c.env), c.haveDB); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestEventsKey(t *testing.T) {
	k, ok := eventsKey(envOf(map[string]string{"EVENTS_HMAC_KEY": "  from-env  "}))
	if !ok || string(k) != "from-env" {
		t.Fatalf("configured key = %q ok=%v", k, ok)
	}
	a, ok := eventsKey(envOf(nil))
	b, _ := eventsKey(envOf(nil))
	if ok || len(a) < 32 || string(a) == string(b) {
		t.Fatal("unset key must be random per call and say it is not configured")
	}
}

func TestSpotifyExchange_EmitsProviderConnectedWithoutSecrets(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-1","refresh_token":"RT-1","expires_in":3600,"scope":"streaming"}`)
	var got []events.Event
	productEventSink = events.SinkFunc(func(e events.Event) { got = append(got, e) })
	t.Cleanup(func() { productEventSink = nil })

	h := spotifyExchangeHandler(spotifyTestStore(t), testRoomSecret, quietLogger(), limiter())
	rec := postJSON(h, `{"code":"c","codeVerifier":"v","redirectUri":"https://x/cb","connToken":"`+testConnToken(t, "sub-9")+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange failed: %d", rec.Code)
	}
	if len(got) != 1 || got[0].Name != events.ProviderConnected || got[0].ActorID != "user:sub-9" ||
		got[0].Props["provider"] != "spotify" || len(got[0].Props) != 1 || got[0].RoomID != "" {
		t.Fatalf("events = %+v", got)
	}
}

func TestSpotifyExchange_FailureEmitsNothing(t *testing.T) {
	spotifyStub(t, 400, `{"error":"invalid_grant"}`)
	called := false
	productEventSink = events.SinkFunc(func(events.Event) { called = true })
	t.Cleanup(func() { productEventSink = nil })

	h := spotifyExchangeHandler(spotifyTestStore(t), testRoomSecret, quietLogger(), limiter())
	postJSON(h, `{"code":"c","codeVerifier":"v","redirectUri":"https://x/cb","connToken":"`+testConnToken(t, "sub-9")+`"}`)
	if called {
		t.Fatal("a rejected exchange must not record a connection")
	}
}
