package flags

import (
	"context"
	"errors"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func ptr[T any](v T) *T { return &v }

func mustFind(t *testing.T, all []Effective, name string) Effective {
	t.Helper()
	e, ok := Find(all, name)
	if !ok {
		t.Fatalf("flag %q missing", name)
	}
	return e
}

// The override wins over the environment, the environment over the default,
// and a cleared override (both fields nil) is the same as none.
func TestResolve_Precedence(t *testing.T) {
	env := envOf(map[string]string{"FEATURE_SYNC": "true", "FEATURE_ROOM_CHAT": "nope"})
	all := Resolve(env, map[string]Override{
		"queueVoting": {Value: Value{Enabled: ptr(true)}},
		"sync":        {Value: Value{Enabled: ptr(false)}},
		"video":       {}, // cleared
		"ghost":       {Value: Value{Enabled: ptr(true)}},
	})
	if len(all) != len(Catalog) {
		t.Fatalf("got %d flags, want %d", len(all), len(Catalog))
	}
	for _, c := range []struct {
		name    string
		enabled bool
		source  string
	}{
		{"sync", false, SourceOverride},
		{"queueVoting", true, SourceOverride},
		{"roomChat", false, SourceDefault}, // unrecognized env value = unset
		{"video", false, SourceDefault},
	} {
		e := mustFind(t, all, c.name)
		if e.Enabled != c.enabled || e.Source != c.source {
			t.Errorf("%s: enabled=%t source=%s, want %t %s", c.name, e.Enabled, e.Source, c.enabled, c.source)
		}
	}
	if e := mustFind(t, all, "sync"); e.EnvValue == nil || !*e.EnvValue {
		t.Error("sync: the env value must still be reported under an override")
	}
	if e := mustFind(t, all, "video"); e.Override != nil {
		t.Error("video: a cleared override must read as none")
	}
}

// Screen share is refused without room auth even when overridden on, and
// its allowlist follows the same override-then-env order.
func TestResolve_ScreenShare(t *testing.T) {
	on := map[string]Override{"screenShare": {Value: Value{Enabled: ptr(true)}}}
	e := mustFind(t, Resolve(envOf(nil), on), "screenShare")
	if e.Enabled || e.Blocked == "" {
		t.Fatalf("without room auth: enabled=%t blocked=%q", e.Enabled, e.Blocked)
	}

	env := envOf(map[string]string{"FEATURE_ROOM_AUTH": "1", "SCREENSHARE_ROOM_ALLOWLIST": " AAA , BBB,"})
	e = mustFind(t, Resolve(env, on), "screenShare")
	if !e.Enabled || e.Blocked != "" || e.RoomsSource != SourceEnv || len(e.Rooms) != 2 || e.Rooms[0] != "AAA" {
		t.Fatalf("env allowlist: %+v", e)
	}

	all := Resolve(env, map[string]Override{"screenShare": {Value: Value{Enabled: ptr(true), Rooms: ptr([]string{})}}})
	e = mustFind(t, all, "screenShare")
	if e.Rooms != nil || e.RoomsSource != SourceOverride {
		t.Fatalf("empty override = every room: rooms=%v source=%s", e.Rooms, e.RoomsSource)
	}

	if e := mustFind(t, all, "sync"); e.Rooms != nil || e.RoomsSource != "" {
		t.Fatalf("a flag without an allowlist has no rooms: %+v", e)
	}
}

func TestParse(t *testing.T) {
	for raw, want := range map[string]*bool{
		"1": ptr(true), "TRUE": ptr(true), "on": ptr(true), "yes": ptr(true),
		"0": ptr(false), "False": ptr(false), "off": ptr(false), "no": ptr(false),
		"": nil, "maybe": nil,
	} {
		got := Parse(raw)
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Errorf("Parse(%q) = %v, want %v", raw, got, want)
		}
	}
}

type fakeStore struct {
	lists []func() (map[string]Override, error)
	calls int
}

func (f *fakeStore) List(context.Context) (map[string]Override, error) {
	i := f.calls
	f.calls++
	if i >= len(f.lists) {
		i = len(f.lists) - 1
	}
	return f.lists[i]()
}
func (f *fakeStore) Set(context.Context, string, Value, string, string) (Value, error) {
	return Value{}, nil
}
func (f *fakeStore) Changes(context.Context, int) ([]Change, error) { return nil, nil }

// A failed read keeps the last applied state: a database blip never flips a
// flag back to its environment value.
func TestRuntime_KeepsLastStateOnError(t *testing.T) {
	st := &fakeStore{lists: []func() (map[string]Override, error){
		func() (map[string]Override, error) {
			return map[string]Override{"roomChat": {Value: Value{Enabled: ptr(true)}}}, nil
		},
		func() (map[string]Override, error) { return nil, errors.New("db down") },
	}}
	var applied [][]Effective
	rt := NewRuntime(envOf(nil), st, func(all []Effective) { applied = append(applied, all) }, nil)
	if len(applied) != 1 || mustFind(t, applied[0], "roomChat").Enabled {
		t.Fatal("NewRuntime must apply the environment once")
	}
	if err := rt.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := rt.Load(context.Background()); err == nil {
		t.Fatal("want the read error")
	}
	if len(applied) != 2 || !mustFind(t, rt.Current(), "roomChat").Enabled {
		t.Fatalf("applied %d times, chat=%t; want 2 and still on", len(applied), mustFind(t, rt.Current(), "roomChat").Enabled)
	}
}

// Postgres: set, clear and the audit chain. Skips without TEST_DATABASE_URL.
func TestPostgres_SetListChanges(t *testing.T) {
	pool := dbtest.Isolated(t)
	st := NewPostgres(pool)
	ctx := context.Background()

	before, err := st.Set(ctx, "screenShare", Value{Enabled: ptr(true), Rooms: ptr([]string{"AAA"})}, "panel", "teste no celular")
	if err != nil {
		t.Fatal(err)
	}
	if !before.IsZero() {
		t.Fatalf("first write: before = %+v, want zero", before)
	}
	if _, err := st.Set(ctx, "screenShare", Value{Rooms: ptr([]string{})}, "cli", ""); err != nil {
		t.Fatal(err)
	}
	got, err := st.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	o := got["screenShare"]
	if o.Enabled != nil || o.Rooms == nil || len(*o.Rooms) != 0 || o.UpdatedBy != "cli" {
		t.Fatalf("after clear: %+v", o)
	}
	changes, err := st.Changes(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 2 {
		t.Fatalf("got %d changes, want 2", len(changes))
	}
	last, first := changes[0], changes[1]
	if first.Actor != "panel" || first.Note != "teste no celular" || first.After.Enabled == nil || !*first.After.Enabled {
		t.Fatalf("first change: %+v", first)
	}
	if last.Before.Enabled == nil || !*last.Before.Enabled || last.After.Enabled != nil || last.After.Rooms == nil {
		t.Fatalf("second change must chain from the first: %+v", last)
	}
}
