package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/rebind"
)

// refreshGrace pins the endpoint's identity-continuity window to the shared
// connauth.RefreshGrace (room.rebind verifies proofs with the same grace).
const refreshGrace = connauth.RefreshGrace

// Connection-token minting is unauthenticated, so it is rate-limited per
// client IP (callerKey). Every page load and reconnect fetches one token, and
// several people can share one address, so the burst is generous.
const (
	connTokenBurst   = 30
	connTokenRefill  = time.Second
	connTokenMaxBody = 8 << 10 // a JWT plus a uuid, with headroom
)

// tokenRequest is the identity-continuity request: the identity the caller
// wants to keep and the previous token proving it owns that identity.
type tokenRequest struct {
	UserID string `json:"userId"`
	Token  string `json:"token"`
}

// readTokenRequest extracts the continuity request. POST carries it in the
// body (JSON or form-encoded); the proof may instead travel in the
// Authorization header as a bearer credential. GET with ?userId=&token= is
// the deprecated form: still honored for one release, but it puts the proof
// in the URL. deprecated reports that the query form was used.
func readTokenRequest(r *http.Request) (req tokenRequest, deprecated bool) {
	if r.Method == http.MethodGet {
		q := r.URL.Query()
		req = tokenRequest{UserID: q.Get("userId"), Token: q.Get("token")}
		return req, req.UserID != "" || req.Token != ""
	}

	body := http.MaxBytesReader(nil, r.Body, connTokenMaxBody)
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	switch mediaType {
	case "application/json":
		_ = json.NewDecoder(body).Decode(&req)
	case "application/x-www-form-urlencoded":
		r.Body = body
		if r.ParseForm() == nil {
			req = tokenRequest{UserID: r.PostForm.Get("userId"), Token: r.PostForm.Get("token")}
		}
	default:
		_, _ = io.Copy(io.Discard, body)
	}
	if bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok && req.Token == "" {
		req.Token = strings.TrimSpace(bearer)
	}
	return req, false
}

// connectionTokenHandler returns a signed JWT for anonymous connection auth.
//
// Identity continuity: a request may ask to keep a previous identity (userId),
// but the server honors it only when the previous token proves ownership
// (valid signature, matching sub, expired no more than refreshGrace ago).
// Without proof the userId is ignored and a fresh identity is minted —
// otherwise anyone could mint a token for any userID (e.g. a room host's, read
// from presence) and be treated as that user. Fail-safe default is always a
// fresh identity, never an error: clients simply adopt whatever userId comes
// back. A sub consumed by a room.rebind upgrade (#172) is dead: refresh for
// it is rejected the same way (fresh identity).
func connectionTokenHandler(roomAuthEnabled bool, roomAuthSecret string, burns rebind.BurnList, limiter *callerLimiter, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")

		if !limiter.allow(callerKey(r), time.Now()) {
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]string{"error": "too many requests"})
			return
		}

		if !roomAuthEnabled {
			w.WriteHeader(http.StatusNotImplemented)
			json.NewEncoder(w).Encode(map[string]string{"error": "connection auth not enabled"})
			return
		}

		req, deprecated := readTokenRequest(r)
		if deprecated {
			// Never log the values: the proof is a live credential.
			logger.Warn("connection_token_query_deprecated",
				"hint", "send userId and token in a POST body; the query form will be removed")
		}

		userID := req.UserID
		if userID != "" {
			sub, err := connauth.ValidateForRefresh([]byte(roomAuthSecret), req.Token, refreshGrace)
			if err != nil || sub != userID {
				userID = ""
			} else if burns != nil {
				// Burn gate (#172): a consumed sub must never be reissued. On a
				// burn-list error, fail safe to a fresh identity as well. The 5s
				// deadline matches the store timeout convention in hub.mutate.
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				consumed, cerr := burns.Consumed(ctx, sub)
				cancel()
				if cerr != nil || consumed {
					userID = ""
				}
			}
		}
		if userID == "" {
			userID = connauth.NewSub()
		}

		token, err := connauth.Mint([]byte(roomAuthSecret), userID, 24*time.Hour)
		if err != nil {
			logger.Error("connection_token_mint_failed", "err", err.Error())
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": "could not mint token"})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"token":  token,
			"userId": userID,
		})
	}
}
