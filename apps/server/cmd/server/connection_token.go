package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
)

// refreshGrace is how long after expiry a previous connection token still proves
// ownership of its identity for reissue. Token TTL is 24h; the grace lets a
// returning user keep their identity across longer absences without making the
// live-token window any wider.
const refreshGrace = 30 * 24 * time.Hour

// connectionTokenHandler returns a signed JWT for anonymous connection auth.
//
// Identity continuity: a request may ask to keep a previous identity via
// ?userId=<sub>, but the server honors it only when ?token=<previous JWT> proves
// ownership (valid signature, matching sub, expired no more than refreshGrace
// ago). Without proof the param is ignored and a fresh identity is minted —
// otherwise anyone could mint a token for any userID (e.g. a room host's, read
// from presence) and be treated as that user. Fail-safe default is always a
// fresh identity, never an error: clients simply adopt whatever userId comes
// back.
func connectionTokenHandler(roomAuthEnabled bool, roomAuthSecret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if !roomAuthEnabled {
			w.WriteHeader(http.StatusNotImplemented)
			json.NewEncoder(w).Encode(map[string]string{"error": "connection auth not enabled"})
			return
		}

		userID := r.URL.Query().Get("userId")
		if userID != "" {
			proof := r.URL.Query().Get("token")
			sub, err := connauth.ValidateForRefresh([]byte(roomAuthSecret), proof, refreshGrace)
			if err != nil || sub != userID {
				userID = ""
			}
		}
		if userID == "" {
			userID = connauth.NewSub()
		}

		token, err := connauth.Mint([]byte(roomAuthSecret), userID, 24*time.Hour)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"token":  token,
			"userId": userID,
		})
	}
}
