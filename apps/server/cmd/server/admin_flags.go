package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/LucasSantana-Dev/cojam/server/internal/flags"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
)

// Feature flag panel (docs/specs/feature-flags-panel.md). The web app's
// /admin/flags page calls these endpoints on the same origin (Caddy routes
// /api/* here). ADMIN_TOKEN is the only credential: one owner, no accounts
// required, compared in constant time, and the endpoints answer 404 when it
// is unset so the surface does not exist by default.
const (
	minAdminTokenLen = 32
	// adminBurst/adminRefill bound every caller, signed in or not: the panel
	// makes a handful of calls per change, and a guesser gets one try every
	// few seconds against a 32-byte secret.
	adminBurst  = 20
	adminRefill = 3 * time.Second
	// adminChangesShown is how much of the trail the panel lists.
	adminChangesShown = 50
	maxAdminNoteLen   = 200
	maxAllowlistRooms = 50
	actorPanel        = "panel"
	actorCLI          = "cli"
)

// adminTokenOK compares the bearer token with the configured one. Both sides
// are hashed first so the comparison takes the same time whatever the
// lengths.
func adminTokenOK(r *http.Request, token string) bool {
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || got == "" {
		return false
	}
	a := sha256.Sum256([]byte(got))
	b := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// adminAuth guards the admin routes: 404 without ADMIN_TOKEN (or with one too
// short to trust), 429 past the per-caller budget, 401 on a wrong token.
func adminAuth(token string, limiter *callerLimiter, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			if len(token) < minAdminTokenLen {
				http.NotFound(w, r)
				return
			}
			if !limiter.allow(callerKey(r), time.Now()) {
				writeAdminError(w, http.StatusTooManyRequests, "Muitas tentativas. Espere alguns segundos.")
				return
			}
			if !adminTokenOK(r, token) {
				if logger != nil {
					logger.Warn("admin_auth_failed", "path", r.URL.Path)
				}
				writeAdminError(w, http.StatusUnauthorized, "Token de admin inválido.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeAdminError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// adminEnv is one environment variable as the panel shows it. Value is the
// parsed toggle (nil = unset or unrecognized); Rooms is only filled for the
// allowlist, which is a list of room ids, never a secret.
type adminEnv struct {
	Name  string    `json:"name"`
	Value *bool     `json:"value,omitempty"`
	Rooms *[]string `json:"rooms,omitempty"`
}

type adminOverride struct {
	Enabled   *bool     `json:"enabled"`
	Rooms     *[]string `json:"roomAllowlist"`
	UpdatedAt time.Time `json:"updatedAt"`
	UpdatedBy string    `json:"updatedBy"`
}

type adminEffective struct {
	Enabled     bool     `json:"enabled"`
	Source      string   `json:"source"`
	Rooms       []string `json:"roomAllowlist"`
	RoomsSource string   `json:"roomAllowlistSource,omitempty"`
}

type adminFlag struct {
	Name         string         `json:"name"`
	Label        string         `json:"label"`
	Help         string         `json:"help"`
	Default      bool           `json:"default"`
	ServerEnv    adminEnv       `json:"serverEnv"`
	WebEnv       string         `json:"webEnv"`
	AllowlistEnv *adminEnv      `json:"allowlistEnv,omitempty"`
	Override     *adminOverride `json:"override"`
	Effective    adminEffective `json:"effective"`
	Blocked      string         `json:"blocked,omitempty"`
}

func toAdminFlag(e flags.Effective, getenv func(string) string) adminFlag {
	f := adminFlag{
		Name: e.Name, Label: e.Label, Help: e.Help, Default: e.Default,
		ServerEnv: adminEnv{Name: e.ServerEnv, Value: e.EnvValue},
		WebEnv:    e.WebEnv,
		Effective: adminEffective{Enabled: e.Enabled, Source: e.Source, Rooms: e.Rooms, RoomsSource: e.RoomsSource},
		Blocked:   e.Blocked,
	}
	if f.Effective.Rooms == nil && e.AllowlistEnv != "" {
		f.Effective.Rooms = []string{}
	}
	if e.AllowlistEnv != "" {
		rooms := flags.ParseRooms(getenv(e.AllowlistEnv))
		if rooms == nil {
			rooms = []string{}
		}
		f.AllowlistEnv = &adminEnv{Name: e.AllowlistEnv, Rooms: &rooms}
	}
	if e.Override != nil {
		f.Override = &adminOverride{Enabled: e.Override.Enabled, Rooms: e.Override.Rooms,
			UpdatedAt: e.Override.UpdatedAt, UpdatedBy: e.Override.UpdatedBy}
	}
	return f
}

type adminFlagsResponse struct {
	Flags       []adminFlag    `json:"flags"`
	Changes     []flags.Change `json:"changes"`
	Writable    bool           `json:"writable"`
	PollSeconds int            `json:"pollSeconds"`
}

// adminFlagsListHandler serves GET /api/admin/flags: every runtime flag with
// its environment, override and effective value, and the recent trail.
func adminFlagsListHandler(rt *flags.Runtime, getenv func(string) string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		// Read fresh so the panel never shows a state older than the poll.
		if err := rt.Load(ctx); err != nil {
			logger.Error("admin_flags_load_failed", "err", err.Error())
			writeAdminError(w, http.StatusServiceUnavailable, "Não foi possível ler as flags do banco.")
			return
		}
		resp := adminFlagsResponse{Writable: rt.HasStore(), PollSeconds: int(restrictionsPollInterval.Seconds()),
			Changes: []flags.Change{}}
		for _, e := range rt.Current() {
			resp.Flags = append(resp.Flags, toAdminFlag(e, getenv))
		}
		if st := rt.Store(); st != nil {
			changes, err := st.Changes(ctx, adminChangesShown)
			if err != nil {
				logger.Error("admin_flags_changes_failed", "err", err.Error())
				writeAdminError(w, http.StatusServiceUnavailable, "Não foi possível ler o histórico de mudanças.")
				return
			}
			if changes != nil {
				resp.Changes = changes
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

type adminFlagUpdate struct {
	Enabled *bool     `json:"enabled"`
	Rooms   *[]string `json:"roomAllowlist"`
	Note    string    `json:"note"`
}

// validateFlagUpdate checks a requested override against the flag and the
// environment. It returns the value to store, or a pt-BR message for the
// panel.
func validateFlagUpdate(def flags.Def, u adminFlagUpdate, getenv func(string) string) (flags.Value, string) {
	if utf8.RuneCountInString(u.Note) > maxAdminNoteLen {
		return flags.Value{}, "A nota passa de 200 caracteres."
	}
	if strings.ContainsAny(u.Note, "\r\n") {
		return flags.Value{}, "A nota precisa caber em uma linha."
	}
	v := flags.Value{Enabled: u.Enabled}
	if u.Rooms != nil {
		if def.AllowlistEnv == "" {
			return flags.Value{}, "Esta flag não tem lista de salas."
		}
		if len(*u.Rooms) > maxAllowlistRooms {
			return flags.Value{}, "A lista aceita no máximo 50 salas."
		}
		seen := make(map[string]bool)
		rooms := []string{}
		for _, id := range *u.Rooms {
			id = strings.ToUpper(strings.TrimSpace(id))
			if id == "" || seen[id] {
				continue
			}
			// Screen share only runs in current-format rooms (12 chars), so
			// a legacy id would be saved and never work.
			if !hub.ValidScreenRoomID(id) {
				return flags.Value{}, "Código de sala inválido: " + id
			}
			seen[id] = true
			rooms = append(rooms, id)
		}
		v.Rooms = &rooms
	}
	if def.NeedsRoomAuth && u.Enabled != nil && *u.Enabled && !featureEnabledIn(getenv, "FEATURE_ROOM_AUTH", false) {
		return flags.Value{}, "Esta flag precisa de FEATURE_ROOM_AUTH ligado no servidor."
	}
	return v, ""
}

// adminFlagUpdateHandler serves PUT /api/admin/flags/{name}: it replaces the
// flag's override (null fields follow the environment), records the change
// and applies it to this server at once instead of waiting for the poll.
func adminFlagUpdateHandler(rt *flags.Runtime, getenv func(string) string, actor string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		def, ok := flags.Lookup(chi.URLParam(r, "name"))
		if !ok {
			writeAdminError(w, http.StatusNotFound, "Flag desconhecida.")
			return
		}
		st := rt.Store()
		if st == nil {
			writeAdminError(w, http.StatusServiceUnavailable, "O servidor está sem banco (DATABASE_URL): as flags seguem só o ambiente.")
			return
		}
		var u adminFlagUpdate
		dec := json.NewDecoder(io.LimitReader(r.Body, 16<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&u); err != nil {
			writeAdminError(w, http.StatusBadRequest, "Pedido inválido.")
			return
		}
		next, msg := validateFlagUpdate(def, u, getenv)
		if msg != "" {
			writeAdminError(w, http.StatusUnprocessableEntity, msg)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		before, err := st.Set(ctx, def.Name, next, actor, strings.TrimSpace(u.Note))
		if err != nil {
			logger.Error("admin_flag_write_failed", "flag", def.Name, "err", err.Error())
			writeAdminError(w, http.StatusServiceUnavailable, "Não foi possível gravar a mudança. Nada mudou.")
			return
		}
		logger.Info("admin_flag_changed", "flag", def.Name, "actor", actor,
			"before_enabled", boolOrNil(before.Enabled), "after_enabled", boolOrNil(next.Enabled),
			"room_allowlist_set", next.Rooms != nil)
		if err := rt.Load(ctx); err != nil {
			// Written but not applied here yet: the poll picks it up.
			logger.Error("admin_flags_reload_failed", "err", err.Error())
		}
		e, _ := flags.Find(rt.Current(), def.Name)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(toAdminFlag(e, getenv))
	}
}

func boolOrNil(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

// publicFeaturesHandler serves GET /api/features: the overridden flags'
// effective values, for the web app's /env.js to merge over its own
// COJAM_FEATURE_* values. Flags without an override are left out so the web
// keeps its environment for them. Booleans only: the allowlist stays
// private to the server.
func publicFeaturesHandler(rt *flags.Runtime) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]bool{}
		for _, e := range rt.Current() {
			if e.Override != nil && e.Override.Enabled != nil {
				out[e.Name] = e.Enabled
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"features": out})
	}
}

// hubFeatures maps the effective flags onto the hub's gates.
func hubFeatures(all []flags.Effective) hub.Features {
	var f hub.Features
	for _, e := range all {
		switch e.Name {
		case "sync":
			f.Sync = e.Enabled
		case "queueVoting":
			f.Voting = e.Enabled
		case "roomChat":
			f.Chat = e.Enabled
		case "publicRooms":
			f.PublicRooms = e.Enabled
		case "video":
			f.Video = e.Enabled
		case "screenShare":
			f.ScreenShare = e.Enabled
			f.ScreenAllowlist = e.Rooms
		}
	}
	return f
}
