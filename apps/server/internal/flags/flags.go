// Package flags holds the feature flags the operator can change while the
// server runs (docs/specs/feature-flags-panel.md). Each flag still has its
// environment variables, which stay the default: an override written to the
// feature_flags table (by the admin panel or `server flag`) wins over them
// until it is cleared, and every change is recorded in feature_flag_changes.
//
// Only flags whose code checks them on every call are here. Flags that wire
// routes, clients or secrets at boot (FEATURE_ROOM_AUTH, FEATURE_MATCHING,
// FEATURE_SUPABASE_AUTH and the like) stay environment only: flipping them at
// runtime would leave half-built state behind.
package flags

import (
	"strings"
	"time"
)

// Def describes one runtime flag. Name is the web client's feature name
// (apps/web/lib/features.ts), so one override reaches both sides.
type Def struct {
	Name  string
	Label string // pt-BR, shown in the panel
	Help  string // pt-BR, one sentence on what turning it on does
	// ServerEnv is the server's FEATURE_* variable, WebEnv the web client's
	// COJAM_FEATURE_* one. Without an override each side reads its own.
	ServerEnv string
	WebEnv    string
	Default   bool
	// AllowlistEnv names the room allowlist variable, "" when the flag has
	// none.
	AllowlistEnv string
	// NeedsRoomAuth refuses the flag while FEATURE_ROOM_AUTH is off.
	NeedsRoomAuth bool
}

// Catalog is every runtime flag, in panel order.
var Catalog = []Def{
	{
		Name: "sync", Label: "Reprodução sincronizada",
		Help:      "Todos na sala ouvem no mesmo ponto da música (play, pause e busca do host).",
		ServerEnv: "FEATURE_SYNC", WebEnv: "COJAM_FEATURE_SYNC",
	},
	{
		Name: "queueVoting", Label: "Votação na fila",
		Help:      "Quem está na sala vota nas músicas da fila e pode pular a atual por votação.",
		ServerEnv: "FEATURE_QUEUE_VOTING", WebEnv: "COJAM_FEATURE_QUEUE_VOTING",
	},
	{
		Name: "roomChat", Label: "Chat da sala",
		Help:      "Chat de texto efêmero dentro da sala, com moderação do host.",
		ServerEnv: "FEATURE_ROOM_CHAT", WebEnv: "COJAM_FEATURE_ROOM_CHAT",
	},
	{
		Name: "publicRooms", Label: "Salas públicas",
		Help:      "O host pode listar a sala no diretório público de salas.",
		ServerEnv: "FEATURE_PUBLIC_ROOMS", WebEnv: "COJAM_FEATURE_PUBLIC_ROOMS",
	},
	{
		Name: "video", Label: "Vídeo junto",
		Help:      "Assistir vídeos do YouTube juntos no palco da sala.",
		ServerEnv: "FEATURE_VIDEO", WebEnv: "COJAM_FEATURE_VIDEO",
	},
	{
		Name: "screenShare", Label: "Compartilhar tela",
		Help:      "Compartilhamento de tela em salas privadas. Desligar encerra os compartilhamentos ao vivo.",
		ServerEnv: "FEATURE_SCREENSHARE", WebEnv: "COJAM_FEATURE_SCREENSHARE",
		AllowlistEnv: "SCREENSHARE_ROOM_ALLOWLIST", NeedsRoomAuth: true,
	},
}

// Lookup returns the flag named name.
func Lookup(name string) (Def, bool) {
	for _, d := range Catalog {
		if d.Name == name {
			return d, true
		}
	}
	return Def{}, false
}

// Value is an override: nil fields follow the environment. Rooms is used
// only by a flag with an allowlist; a non-nil empty list means every
// eligible room.
type Value struct {
	Enabled *bool     `json:"enabled"`
	Rooms   *[]string `json:"roomAllowlist"`
}

// IsZero reports whether the value follows the environment entirely.
func (v Value) IsZero() bool { return v.Enabled == nil && v.Rooms == nil }

// Override is a stored row.
type Override struct {
	Value
	UpdatedAt time.Time
	UpdatedBy string
}

// Change is one row of the audit trail.
type Change struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Before    Value     `json:"before"`
	After     Value     `json:"after"`
	Actor     string    `json:"actor"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"createdAt"`
}

// Sources of an effective value.
const (
	SourceOverride = "override"
	SourceEnv      = "env"
	SourceDefault  = "default"
)

// Effective is a flag as the server applies it right now.
type Effective struct {
	Def
	Enabled bool
	Source  string
	// EnvValue is the server environment's value, nil when unset or
	// unrecognized.
	EnvValue *bool
	// Rooms is the allowlist in force (nil = every eligible room), and
	// RoomsSource where it came from. Both empty for a flag without one.
	Rooms       []string
	RoomsSource string
	// Blocked explains why an override that turns the flag on is not
	// applied (pt-BR, for the panel). "" when nothing blocks it.
	Blocked  string
	Override *Override
}

// Parse reads one toggle value the way the server and web client always
// have: 1/true/on/yes, 0/false/off/no (any case), nil for unset or anything
// else.
func Parse(raw string) *bool {
	switch strings.ToLower(raw) {
	case "1", "true", "on", "yes":
		t := true
		return &t
	case "0", "false", "off", "no":
		f := false
		return &f
	default:
		return nil
	}
}

// ParseRooms splits a comma-separated room list, dropping blanks. Empty
// input is nil (every eligible room).
func ParseRooms(raw string) []string {
	var ids []string
	for _, id := range strings.Split(raw, ",") {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

const blockedNeedsRoomAuth = "Precisa de FEATURE_ROOM_AUTH ligado no servidor: sem host ninguém controla o compartilhamento."

// Resolve combines the environment with the stored overrides, in Catalog
// order. An override for an unknown name is ignored.
func Resolve(getenv func(string) string, overrides map[string]Override) []Effective {
	roomAuth := Parse(getenv("FEATURE_ROOM_AUTH"))
	out := make([]Effective, 0, len(Catalog))
	for _, d := range Catalog {
		e := Effective{Def: d, EnvValue: Parse(getenv(d.ServerEnv))}
		if o, ok := overrides[d.Name]; ok && !o.IsZero() {
			o := o
			e.Override = &o
		}
		switch {
		case e.Override != nil && e.Override.Enabled != nil:
			e.Enabled, e.Source = *e.Override.Enabled, SourceOverride
		case e.EnvValue != nil:
			e.Enabled, e.Source = *e.EnvValue, SourceEnv
		default:
			e.Enabled, e.Source = d.Default, SourceDefault
		}
		if d.NeedsRoomAuth && e.Enabled && (roomAuth == nil || !*roomAuth) {
			// The environment path is already fatal at boot (config.go), so
			// only an override can get here.
			e.Enabled, e.Blocked = false, blockedNeedsRoomAuth
		}
		if d.AllowlistEnv != "" {
			if e.Override != nil && e.Override.Rooms != nil {
				e.Rooms, e.RoomsSource = append([]string(nil), *e.Override.Rooms...), SourceOverride
			} else {
				e.Rooms, e.RoomsSource = ParseRooms(getenv(d.AllowlistEnv)), SourceEnv
			}
			if len(e.Rooms) == 0 {
				e.Rooms = nil
			}
		}
		out = append(out, e)
	}
	return out
}

// Find returns the effective flag named name from a Resolve result.
func Find(all []Effective, name string) (Effective, bool) {
	for _, e := range all {
		if e.Name == name {
			return e, true
		}
	}
	return Effective{}, false
}
