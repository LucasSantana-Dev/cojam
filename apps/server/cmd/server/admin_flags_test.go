package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
	"github.com/LucasSantana-Dev/cojam/server/internal/flags"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
)

var testAdminToken = strings.Repeat("k", minAdminTokenLen)

// memFlagStore is an in-memory flags.Store.
type memFlagStore struct {
	mu      sync.Mutex
	rows    map[string]flags.Override
	changes []flags.Change
	failSet bool
}

func (m *memFlagStore) List(context.Context) (map[string]flags.Override, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]flags.Override, len(m.rows))
	for k, v := range m.rows {
		out[k] = v
	}
	return out, nil
}

func (m *memFlagStore) Set(_ context.Context, name string, next flags.Value, actor, note string) (flags.Value, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failSet {
		return flags.Value{}, context.DeadlineExceeded
	}
	before := m.rows[name].Value
	if m.rows == nil {
		m.rows = map[string]flags.Override{}
	}
	m.rows[name] = flags.Override{Value: next, UpdatedAt: time.Now(), UpdatedBy: actor}
	m.changes = append([]flags.Change{{ID: int64(len(m.changes) + 1), Name: name, Before: before, After: next, Actor: actor, Note: note}}, m.changes...)
	return before, nil
}

func (m *memFlagStore) Changes(context.Context, int) ([]flags.Change, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]flags.Change(nil), m.changes...), nil
}

type adminRig struct {
	srv     *httptest.Server
	store   *memFlagStore
	applied []hub.Features
	mu      sync.Mutex
}

func newAdminRig(t *testing.T, token string, env map[string]string, store flags.Store) *adminRig {
	t.Helper()
	rig := &adminRig{}
	if m, ok := store.(*memFlagStore); ok {
		rig.store = m
	}
	getenv := envOf(env)
	rt := flags.NewRuntime(getenv, store, func(all []flags.Effective) {
		rig.mu.Lock()
		defer rig.mu.Unlock()
		rig.applied = append(rig.applied, hubFeatures(all))
	}, nil)
	r := chi.NewRouter()
	r.Get("/api/features", publicFeaturesHandler(rt))
	r.Route("/api/admin", func(ar chi.Router) {
		ar.Use(adminAuth(token, newCallerLimiter(adminBurst, adminRefill), discardLogger()))
		ar.Get("/flags", adminFlagsListHandler(rt, getenv, discardLogger()))
		ar.Put("/flags/{name}", adminFlagUpdateHandler(rt, getenv, actorPanel, discardLogger()))
	})
	rig.srv = httptest.NewServer(r)
	t.Cleanup(rig.srv.Close)
	return rig
}

func (rig *adminRig) do(t *testing.T, method, path, token, body string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, rig.srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res, out
}

func (rig *adminRig) last() hub.Features {
	rig.mu.Lock()
	defer rig.mu.Unlock()
	return rig.applied[len(rig.applied)-1]
}

// The panel's surface does not exist without a usable ADMIN_TOKEN.
func TestAdminAuth_NotFoundWithoutToken(t *testing.T) {
	for _, token := range []string{"", "short"} {
		rig := newAdminRig(t, token, nil, &memFlagStore{})
		if res, _ := rig.do(t, "GET", "/api/admin/flags", token, ""); res.StatusCode != http.StatusNotFound {
			t.Errorf("token %q: status %d, want 404", token, res.StatusCode)
		}
	}
}

func TestAdminAuth_WrongTokenAndRateLimit(t *testing.T) {
	rig := newAdminRig(t, testAdminToken, nil, &memFlagStore{})
	if res, _ := rig.do(t, "GET", "/api/admin/flags", "", ""); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	if res, _ := rig.do(t, "GET", "/api/admin/flags", strings.Repeat("x", minAdminTokenLen), ""); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", res.StatusCode)
	}
	res, _ := rig.do(t, "GET", "/api/admin/flags", testAdminToken, "")
	if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("right token: %d cache=%q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	limited := false
	for i := 0; i < adminBurst+1; i++ {
		if res, _ := rig.do(t, "GET", "/api/admin/flags", "", ""); res.StatusCode == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("guessing was never rate limited")
	}
}

// A panel write is stored with its note, applied to the hub at once and
// published to /api/features; clearing it hands the flag back to the env.
func TestAdminFlagUpdate_AppliesAtOnce(t *testing.T) {
	store := &memFlagStore{}
	rig := newAdminRig(t, testAdminToken, map[string]string{"FEATURE_ROOM_CHAT": "true"}, store)

	res, body := rig.do(t, "PUT", "/api/admin/flags/roomChat", testAdminToken, `{"enabled":false,"roomAllowlist":null,"note":"spam no chat"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put: %d %v", res.StatusCode, body)
	}
	if rig.last().Chat {
		t.Fatal("the hub still has chat on")
	}
	if eff := body["effective"].(map[string]any); eff["enabled"] != false || eff["source"] != "override" {
		t.Fatalf("effective = %v", eff)
	}
	if len(store.changes) != 1 || store.changes[0].Note != "spam no chat" || store.changes[0].Actor != actorPanel {
		t.Fatalf("trail = %+v", store.changes)
	}
	_, pub := rig.do(t, "GET", "/api/features", "", "")
	if got := pub["features"].(map[string]any); got["roomChat"] != false || len(got) != 1 {
		t.Fatalf("public features = %v", got)
	}

	if res, _ := rig.do(t, "PUT", "/api/admin/flags/roomChat", testAdminToken, `{"enabled":null,"roomAllowlist":null,"note":""}`); res.StatusCode != http.StatusOK {
		t.Fatalf("clear: %d", res.StatusCode)
	}
	if !rig.last().Chat {
		t.Fatal("clearing the override must bring back the env value")
	}
	_, pub = rig.do(t, "GET", "/api/features", "", "")
	if got := pub["features"].(map[string]any); len(got) != 0 {
		t.Fatalf("a cleared flag must leave /api/features: %v", got)
	}

	_, list := rig.do(t, "GET", "/api/admin/flags", testAdminToken, "")
	if n := len(list["changes"].([]any)); n != 2 {
		t.Fatalf("list shows %d changes, want 2", n)
	}
}

func TestAdminFlagUpdate_Refusals(t *testing.T) {
	store := &memFlagStore{}
	rig := newAdminRig(t, testAdminToken, nil, store)
	for name, c := range map[string]struct {
		path, body string
		status     int
	}{
		"unknown flag":        {"/api/admin/flags/ghost", `{"enabled":true}`, http.StatusNotFound},
		"bad json":            {"/api/admin/flags/sync", `{"enabled":`, http.StatusBadRequest},
		"unknown field":       {"/api/admin/flags/sync", `{"enabled":true,"force":true}`, http.StatusBadRequest},
		"rooms on sync":       {"/api/admin/flags/sync", `{"enabled":true,"roomAllowlist":["ROOM1"]}`, http.StatusUnprocessableEntity},
		"bad room id":         {"/api/admin/flags/screenShare", `{"enabled":false,"roomAllowlist":["no way"]}`, http.StatusUnprocessableEntity},
		"legacy room id":      {"/api/admin/flags/screenShare", `{"enabled":false,"roomAllowlist":["ABC123"]}`, http.StatusUnprocessableEntity},
		"needs room auth":     {"/api/admin/flags/screenShare", `{"enabled":true}`, http.StatusUnprocessableEntity},
		"multi-line note":     {"/api/admin/flags/sync", `{"enabled":true,"note":"a\nb"}`, http.StatusUnprocessableEntity},
		"note over 200 runes": {"/api/admin/flags/sync", `{"enabled":true,"note":"` + strings.Repeat("é", 201) + `"}`, http.StatusUnprocessableEntity},
	} {
		if res, body := rig.do(t, "PUT", c.path, testAdminToken, c.body); res.StatusCode != c.status {
			t.Errorf("%s: status %d (%v), want %d", name, res.StatusCode, body, c.status)
		}
	}
	if len(store.changes) != 0 {
		t.Fatalf("a refused write was recorded: %+v", store.changes)
	}

	store.failSet = true
	if res, _ := rig.do(t, "PUT", "/api/admin/flags/sync", testAdminToken, `{"enabled":true}`); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("store failure: %d", res.StatusCode)
	}
}

// The allowlist is normalized (upper case, trimmed, deduplicated) before it
// is stored and reaches the hub.
func TestAdminFlagUpdate_ScreenAllowlist(t *testing.T) {
	store := &memFlagStore{}
	rig := newAdminRig(t, testAdminToken, map[string]string{"FEATURE_ROOM_AUTH": "true"}, store)
	res, body := rig.do(t, "PUT", "/api/admin/flags/screenShare", testAdminToken,
		`{"enabled":true,"roomAllowlist":[" abcdef123456 ","ABCDEF123456",""],"note":"teste"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put: %d %v", res.StatusCode, body)
	}
	f := rig.last()
	if !f.ScreenShare || len(f.ScreenAllowlist) != 1 || f.ScreenAllowlist[0] != "ABCDEF123456" {
		t.Fatalf("hub got %+v", f)
	}
}

// Without a database the panel reads the environment and refuses writes.
func TestAdminFlags_NoDatabase(t *testing.T) {
	rig := newAdminRig(t, testAdminToken, map[string]string{"FEATURE_SYNC": "on"}, nil)
	res, body := rig.do(t, "GET", "/api/admin/flags", testAdminToken, "")
	if res.StatusCode != http.StatusOK || body["writable"] != false {
		t.Fatalf("list: %d %v", res.StatusCode, body)
	}
	if res, _ := rig.do(t, "PUT", "/api/admin/flags/sync", testAdminToken, `{"enabled":false}`); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("put: %d", res.StatusCode)
	}
}

// Every runtime flag must reach a hub gate: a catalog entry hubFeatures does
// not map would show in the panel and change nothing.
func TestHubFeatures_CoversTheCatalog(t *testing.T) {
	for _, d := range flags.Catalog {
		on := map[string]flags.Override{d.Name: {Value: flags.Value{Enabled: ptrBool(true)}}}
		got := hubFeatures(flags.Resolve(envOf(map[string]string{"FEATURE_ROOM_AUTH": "1"}), on))
		if !got.Sync && !got.Voting && !got.Chat && !got.PublicRooms && !got.Video && !got.ScreenShare {
			t.Errorf("flag %q does not reach the hub", d.Name)
		}
	}
}

func ptrBool(b bool) *bool { return &b }

func TestRunFlag_RejectsBadInvocations(t *testing.T) {
	env := envOf(map[string]string{"DATABASE_URL": "postgres://unused/db"})
	for name, args := range map[string][]string{
		"no name":          {"--on", "--apply"},
		"unknown name":     {"--name", "ghost", "--on", "--apply"},
		"no action":        {"--name", "sync", "--apply"},
		"two actions":      {"--name", "sync", "--on", "--off", "--apply"},
		"no mode":          {"--name", "sync", "--on"},
		"both modes":       {"--name", "sync", "--on", "--dry-run", "--apply"},
		"rooms twice":      {"--name", "screenShare", "--off", "--rooms", "A", "--rooms-default", "--apply"},
		"list with action": {"--list", "--on"},
		"stray positional": {"--name", "sync", "--on", "--apply", "extra"},
	} {
		var out, errOut bytes.Buffer
		if code := runFlag(args, env, &out, &errOut); code != 2 {
			t.Errorf("%s: exit = %d, want 2 (stderr %q)", name, code, errOut.String())
		}
	}
	var out, errOut bytes.Buffer
	if code := runFlag([]string{"--list"}, envOf(nil), &out, &errOut); code != 2 ||
		!strings.Contains(errOut.String(), "DATABASE_URL") {
		t.Fatalf("missing DATABASE_URL: exit %d, stderr %q", code, errOut.String())
	}
}

// The command end to end: a dry run changes nothing, apply records the
// change, --default hands the flag back. Skips without TEST_DATABASE_URL.
func TestRunFlag_SetAndList(t *testing.T) {
	pool := dbtest.Isolated(t)
	env := envOf(map[string]string{"DATABASE_URL": pool.Config().ConnString(), "FEATURE_ROOM_AUTH": "1"})
	run := func(args ...string) (int, string, string) {
		var out, errOut bytes.Buffer
		code := runFlag(args, env, &out, &errOut)
		return code, out.String(), errOut.String()
	}
	if code, out, _ := run("--name", "screenShare", "--on", "--rooms", "abcdef123456", "--dry-run"); code != 0 ||
		!strings.Contains(out, "after:  enabled=on rooms=ABCDEF123456") || !strings.Contains(out, "dry run") {
		t.Fatalf("dry run: %d %q", code, out)
	}
	if code, out, _ := run("--list"); code != 0 || !strings.Contains(out, "screenShare  effective=off") {
		t.Fatalf("a dry run must change nothing: %d %q", code, out)
	}
	if code, out, errOut := run("--name", "screenShare", "--on", "--rooms", "abcdef123456", "--note", "teste", "--apply"); code != 0 ||
		!strings.Contains(out, "committed") {
		t.Fatalf("apply: %d %q %q", code, out, errOut)
	}
	if code, out, _ := run("--list"); code != 0 || !strings.Contains(out, "screenShare  effective=on  source=override") ||
		!strings.Contains(out, "rooms=ABCDEF123456") {
		t.Fatalf("list after apply: %d %q", code, out)
	}
	if code, out, _ := run("--name", "screenShare", "--default", "--rooms-default", "--apply"); code != 0 ||
		!strings.Contains(out, "after:  enabled=default") {
		t.Fatalf("default: %d %q", code, out)
	}
	changes, err := flags.NewPostgres(pool).Changes(context.Background(), 10)
	if err != nil || len(changes) != 2 || changes[1].Actor != actorCLI || changes[1].Note != "teste" {
		t.Fatalf("trail: %v %+v", err, changes)
	}
}
