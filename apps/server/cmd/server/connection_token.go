package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/rebind"
)

// refreshGrace pins the endpoint's identity-continuity window to the shared
// connauth.RefreshGrace (room.rebind verifies proofs with the same grace).
const refreshGrace = connauth.RefreshGrace

// connectionTokenHandler returns a signed JWT for anonymous connection auth.
//
// Identity continuity: a request may ask to keep a previous identity via
// ?userId=<sub>, but the server honors it only when ?token=<previous JWT> proves
// ownership (valid signature, matching sub, expired no more than refreshGrace
// ago). Without proof the param is ignored and a fresh identity is minted —
// otherwise anyone could mint a token for any userID (e.g. a room host's, read
// from presence) and be treated as that user. Fail-safe default is always a
// fresh identity, never an error: clients simply adopt whatever userId comes
// back. A sub consumed by a room.rebind upgrade (#172) is dead: refresh for
// it is rejected the same way (fresh identity).
func connectionTokenHandler(roomAuthEnabled bool, roomAuthSecret string, burns rebind.BurnList) http.HandlerFunc {
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
			} else if burns != nil {
				// Burn gate (#172): a consumed sub must never be reissued. On a
				// burn-list error, fail safe to a fresh identity as well.
				consumed, cerr := burns.Consumed(r.Context(), sub)
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
