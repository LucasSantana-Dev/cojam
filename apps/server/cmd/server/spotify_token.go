package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifyauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifytoken"
)

// Second half of #252. The browser never sees a refresh token: it posts the
// authorization code here, and gets back only a short-lived access token.
//
// See docs/specs/252-spotify-server-side-token-exchange.md.
const (
	// How long a stored refresh token stays usable without being exercised.
	// Bounded so an abandoned guest session does not leave a live Spotify
	// credential behind indefinitely.
	spotifyRecordTTL = 30 * 24 * time.Hour

	// These endpoints reach Spotify, so they draw on a shared budget like the
	// hub's fanoutLimiter rather than being unlimited.
	spotifyBurst  = 10
	spotifyRefill = 2 * time.Second

	spotifyMaxBody = 8 << 10
)

type spotifyExchangeRequest struct {
	Code         string `json:"code"`
	CodeVerifier string `json:"codeVerifier"`
	RedirectURI  string `json:"redirectUri"`
	// ConnToken is the caller's connection JWT. Its `sub` is the identity the
	// refresh token is filed under, reusing the guest identity #172 already
	// treats as proof of ownership.
	ConnToken string `json:"connToken"`
}

type spotifyRefreshRequest struct {
	ConnToken string `json:"connToken"`
}

type spotifyAccessResponse struct {
	AccessToken string `json:"accessToken"`
	ExpiresIn   int    `json:"expiresIn"`
	Scope       string `json:"scope,omitempty"`
}

// spotifyTokenReply is Spotify's own response shape.
type spotifyTokenReply struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
}

// callerSub resolves the caller's identity from their connection JWT. An
// unverifiable token means no identity, and therefore no stored credential to
// reach — this is the authorization boundary for both endpoints.
func callerSub(secret string, token string) (string, error) {
	if secret == "" {
		return "", errors.New("room auth not configured")
	}
	return connauth.Validate([]byte(secret), token)
}

// postSpotifyForm posts a form to Spotify's token endpoint and decodes the
// reply. Errors never carry the response body: it can echo our own client
// secret back at us.
func postSpotifyForm(ctx context.Context, form url.Values) (*spotifyTokenReply, error) {
	form.Set("client_id", spotifyauth.ClientID)
	form.Set("client_secret", spotifyauth.ClientSecret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, spotifyauth.TokenURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := spotifyauth.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var reply spotifyTokenReply
	if err := json.NewDecoder(io.LimitReader(resp.Body, httpx.MaxResponseBytes)).Decode(&reply); err != nil {
		return nil, errors.New("could not decode the Spotify token response")
	}
	if resp.StatusCode/100 != 2 {
		// reply.Error is Spotify's own code ("invalid_grant"), not free text.
		return &reply, errors.New("spotify token request failed: " + reply.Error)
	}
	return &reply, nil
}

func writeSpotifyJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

// spotifyExchangeHandler swaps an authorization code for tokens, keeps the
// refresh token, and returns only the access token.
func spotifyExchangeHandler(
	store spotifytoken.Store, roomAuthSecret string, logger *slog.Logger, limiter *callerLimiter,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if spotifyauth.ClientID == "" || spotifyauth.ClientSecret == "" {
			writeSpotifyJSON(w, http.StatusNotImplemented, map[string]string{"error": "spotify not configured"})
			return
		}
		if !limiter.allow(callerKey(r), time.Now()) {
			writeSpotifyJSON(w, http.StatusTooManyRequests, map[string]string{"error": "slow down"})
			return
		}

		var req spotifyExchangeRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, spotifyMaxBody)).Decode(&req); err != nil {
			writeSpotifyJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed request"})
			return
		}
		if req.Code == "" || req.CodeVerifier == "" || req.RedirectURI == "" {
			writeSpotifyJSON(w, http.StatusBadRequest, map[string]string{"error": "missing code, verifier or redirect"})
			return
		}

		sub, err := callerSub(roomAuthSecret, req.ConnToken)
		if err != nil {
			writeSpotifyJSON(w, http.StatusUnauthorized, map[string]string{"error": "unrecognised connection token"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		// PKCE is kept alongside the client secret. It costs nothing and
		// preserves the binding between this browser and this code.
		reply, err := postSpotifyForm(ctx, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {req.Code},
			"redirect_uri":  {req.RedirectURI},
			"code_verifier": {req.CodeVerifier},
		})
		if err != nil {
			logger.Warn("spotify_exchange_failed", "err", err.Error())
			writeSpotifyJSON(w, http.StatusBadGateway, map[string]string{"error": "spotify rejected the exchange"})
			return
		}

		if reply.RefreshToken != "" {
			if err := store.Put(ctx, sub, reply.RefreshToken, time.Now().Add(spotifyRecordTTL)); err != nil {
				// Storing failed, but the access token is still good. Degrade to
				// a session that cannot refresh rather than failing the connect.
				logger.Error("spotify_token_store_failed", "err", err.Error())
			}
		}

		writeSpotifyJSON(w, http.StatusOK, spotifyAccessResponse{
			AccessToken: reply.AccessToken,
			ExpiresIn:   reply.ExpiresIn,
			Scope:       reply.Scope,
		})
	}
}

// spotifyRefreshHandler mints a fresh access token from the stored refresh
// token. The refresh token itself never leaves the server.
func spotifyRefreshHandler(
	store spotifytoken.Store, roomAuthSecret string, logger *slog.Logger, limiter *callerLimiter,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if spotifyauth.ClientID == "" || spotifyauth.ClientSecret == "" {
			writeSpotifyJSON(w, http.StatusNotImplemented, map[string]string{"error": "spotify not configured"})
			return
		}
		if !limiter.allow(callerKey(r), time.Now()) {
			writeSpotifyJSON(w, http.StatusTooManyRequests, map[string]string{"error": "slow down"})
			return
		}

		var req spotifyRefreshRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, spotifyMaxBody)).Decode(&req); err != nil {
			writeSpotifyJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed request"})
			return
		}
		sub, err := callerSub(roomAuthSecret, req.ConnToken)
		if err != nil {
			writeSpotifyJSON(w, http.StatusUnauthorized, map[string]string{"error": "unrecognised connection token"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		refreshToken, err := store.Get(ctx, sub)
		if errors.Is(err, spotifytoken.ErrNotFound) {
			// Nothing filed, or it expired. The client's remedy is to reconnect,
			// which is a different UX from a transient failure.
			writeSpotifyJSON(w, http.StatusNotFound, map[string]string{"error": "reconnect required"})
			return
		}
		if err != nil {
			logger.Error("spotify_token_load_failed", "err", err.Error())
			writeSpotifyJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load the stored token"})
			return
		}

		reply, err := postSpotifyForm(ctx, url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {refreshToken},
		})
		if err != nil {
			// invalid_grant means the user revoked the grant in Spotify. Retrying
			// can never succeed, so drop the record and ask for a reconnect.
			if reply != nil && reply.Error == "invalid_grant" {
				if delErr := store.Delete(ctx, sub); delErr != nil {
					logger.Error("spotify_token_delete_failed", "err", delErr.Error())
				}
				logger.Info("spotify_grant_revoked")
				writeSpotifyJSON(w, http.StatusNotFound, map[string]string{"error": "reconnect required"})
				return
			}
			logger.Warn("spotify_refresh_failed", "err", err.Error())
			writeSpotifyJSON(w, http.StatusBadGateway, map[string]string{"error": "spotify rejected the refresh"})
			return
		}

		// Spotify may rotate the refresh token on use; persist the new one or
		// the next refresh fails against a token Spotify has retired.
		if reply.RefreshToken != "" && reply.RefreshToken != refreshToken {
			if err := store.Put(ctx, sub, reply.RefreshToken, time.Now().Add(spotifyRecordTTL)); err != nil {
				logger.Error("spotify_token_rotate_failed", "err", err.Error())
			}
		}

		writeSpotifyJSON(w, http.StatusOK, spotifyAccessResponse{
			AccessToken: reply.AccessToken,
			ExpiresIn:   reply.ExpiresIn,
			Scope:       reply.Scope,
		})
	}
}
