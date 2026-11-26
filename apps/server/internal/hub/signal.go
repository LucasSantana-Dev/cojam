package hub

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/centrifugal/centrifuge"
)

// WebRTC signaling relay for screen share (#310, spec 2.3 and 2.4).
//
// rtc.signal carries SDP and ICE candidates between the broadcaster and one
// admitted viewer. The server reads only what it needs to route and to
// refuse: who may talk to whom, in which direction, and how much. SDP is
// opaque beyond its "v=0" prefix and is never logged or persisted: it carries
// IP addresses. Messages reach the target with centrifuge's Client.Send, an
// asynchronous message on that one connection, so there is no channel anyone
// else could subscribe to.

// rtcSignalMaxBytes caps the raw rtc.signal params, checked before decoding.
const rtcSignalMaxBytes = 16 * 1024

// rtcMaxCandidates caps the ICE candidates in one batch.
const rtcMaxCandidates = 20

// rtcMaxCandidateLen caps one candidate line and its mid/ufrag fields.
const rtcMaxCandidateLen = 512

// Defaults for the rtc.signal limiter, sized for the broadcaster side of five
// simultaneous joins (5 offers, about 5 candidate batches each, 5
// end-of-candidates: about 35 messages inside two seconds). The prototype in
// spec section 8 measures the real count. Tests shrink h.rtcLimiter.
const (
	rtcBurst  = 60
	rtcRefill = 100 * time.Millisecond
)

// rtcMethods draw from rtcLimiter.
var rtcMethods = map[string]bool{"rtc.signal": true}

// checkRTCLimit enforces the per-caller bucket on rtc.signal.
func (h *Hub) checkRTCLimit(method, rlKey string) error {
	if !rtcMethods[method] || h.rtcLimiter == nil {
		return nil
	}
	if !h.rtcLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// signalKind values of SignalPayload.kind.
const (
	signalOffer            = "offer"
	signalAnswer           = "answer"
	signalCandidates       = "candidates"
	signalEndOfCandidates  = "end-of-candidates"
	signalBye              = "bye"
	errSignalPayloadFormat = "invalid signal payload"
)

// iceCandidate mirrors RTCIceCandidateInit. Unknown fields are refused.
type iceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// signalPayload is the validated union. Only the fields of its kind are set.
type signalPayload struct {
	Kind       string         `json:"kind"`
	SDP        string         `json:"sdp,omitempty"`
	Candidates []iceCandidate `json:"candidates,omitempty"`
}

// decodeStrict decodes data into v, refusing unknown fields and trailing
// data.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

// parseSignalPayload validates the payload shape for its kind: unknown kind,
// extra fields, a non-SDP sdp or an oversized candidate batch are refused.
func parseSignalPayload(raw json.RawMessage) (signalPayload, error) {
	var probe struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return signalPayload{}, userErrorf(errSignalPayloadFormat)
	}
	switch probe.Kind {
	case signalOffer, signalAnswer:
		var p struct {
			Kind string `json:"kind"`
			SDP  string `json:"sdp"`
		}
		if err := decodeStrict(raw, &p); err != nil || !strings.HasPrefix(p.SDP, "v=0") {
			return signalPayload{}, userErrorf(errSignalPayloadFormat)
		}
		return signalPayload{Kind: p.Kind, SDP: p.SDP}, nil
	case signalCandidates:
		var p struct {
			Kind       string         `json:"kind"`
			Candidates []iceCandidate `json:"candidates"`
		}
		if err := decodeStrict(raw, &p); err != nil || len(p.Candidates) == 0 || len(p.Candidates) > rtcMaxCandidates {
			return signalPayload{}, userErrorf(errSignalPayloadFormat)
		}
		for _, c := range p.Candidates {
			if len(c.Candidate) > rtcMaxCandidateLen ||
				(c.SDPMid != nil && len(*c.SDPMid) > rtcMaxCandidateLen) ||
				(c.UsernameFragment != nil && len(*c.UsernameFragment) > rtcMaxCandidateLen) {
				return signalPayload{}, userErrorf(errSignalPayloadFormat)
			}
		}
		return signalPayload{Kind: p.Kind, Candidates: p.Candidates}, nil
	case signalEndOfCandidates, signalBye:
		var p struct {
			Kind string `json:"kind"`
		}
		if err := decodeStrict(raw, &p); err != nil {
			return signalPayload{}, userErrorf(errSignalPayloadFormat)
		}
		return signalPayload{Kind: p.Kind}, nil
	}
	return signalPayload{}, userErrorf(errSignalPayloadFormat)
}

// rtcSignal relays one signaling message (spec 2.4). Membership of the caller
// is checked by Authorize (rtc.signal is in mutatingMethods) and the rate
// limit by checkRateLimits, both before this runs. Every routing decision
// comes from server-held state: the payload names a target, never a sender.
func (h *Hub) rtcSignal(data []byte, clientID, userID string) (json.RawMessage, error) {
	if len(data) > rtcSignalMaxBytes {
		return nil, userErrorf("signal too large")
	}
	var req struct {
		RoomID  string          `json:"roomId"`
		To      string          `json:"to"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := decodeStrict(data, &req); err != nil {
		return nil, userErrorf(errSignalPayloadFormat)
	}
	if req.RoomID == "" || req.To == "" || len(req.Payload) == 0 {
		return nil, userErrorf(errSignalPayloadFormat)
	}
	payload, err := parseSignalPayload(req.Payload)
	if err != nil {
		return nil, err
	}

	room := h.residentRoom(req.RoomID)
	if room == nil {
		return nil, userErrorf("Ninguém está compartilhando a tela agora.")
	}
	room.mu.Lock()
	cur := room.screen
	var fromBroadcaster, toBroadcaster, pairOK bool
	if cur != nil {
		fromBroadcaster = cur.broadcasterClientID == clientID
		toBroadcaster = cur.broadcasterClientID == req.To
		// Only the pair (broadcaster, admitted viewer), in either direction:
		// rtc.signal must never become an unmoderated direct-message channel
		// between viewers or to members who did not ask to watch.
		pairOK = (fromBroadcaster && cur.isViewer(req.To)) || (toBroadcaster && cur.isViewer(clientID))
	}
	room.mu.Unlock()
	if cur == nil {
		return nil, userErrorf("Ninguém está compartilhando a tela agora.")
	}
	if !pairOK {
		return nil, userErrorf("signal not allowed between these members")
	}
	// Direction: the broadcaster is the only offerer, so there is no glare.
	switch payload.Kind {
	case signalOffer:
		if !fromBroadcaster {
			return nil, userErrorf("only the broadcaster sends offers")
		}
	case signalAnswer:
		if !toBroadcaster {
			return nil, userErrorf("only viewers send answers")
		}
	}
	// A vanished viewer frees its slot; a vanished broadcaster is left to its
	// own disconnect, so a viewer's signal can never end someone's share.
	if !h.IsMember(req.To, req.RoomID) {
		if fromBroadcaster {
			h.screenLeave(req.RoomID, req.To, screenEndDisconnect)
		}
		return nil, userErrorf("Essa pessoa não está mais conectada.")
	}

	msg, err := json.Marshal(struct {
		Type    string        `json:"type"`
		RoomID  string        `json:"roomId"`
		From    string        `json:"from"`
		Payload signalPayload `json:"payload"`
	}{"rtc.signal", req.RoomID, clientID, payload})
	if err != nil {
		return nil, err
	}
	if err := h.sendToClient(req.To, msg); err != nil {
		if fromBroadcaster {
			h.screenLeave(req.RoomID, req.To, screenEndDisconnect)
		}
		return nil, userErrorf("Essa pessoa não está mais conectada.")
	}
	if h.logger != nil {
		// Never the payload: SDP and candidates carry IP addresses.
		h.logger.Debug("rtc_signal", "room_id", req.RoomID, "from", clientID, "to", req.To, "kind", payload.Kind, "size", len(data))
	}
	return json.Marshal(map[string]string{})
}

// notifyScreenViewer tells target that viewerClientID joined or left the
// share in roomID: the broadcaster opens or closes that peer, and a viewer
// that receives its own id with "leave" tears its side down. Best effort: a
// target that vanished is cleaned up by its own disconnect.
func (h *Hub) notifyScreenViewer(target, roomID, viewerClientID, action string) {
	if target == "" {
		return
	}
	msg, err := json.Marshal(map[string]string{
		"type":     "screen.viewer",
		"roomId":   roomID,
		"clientId": viewerClientID,
		"action":   action,
	})
	if err != nil {
		return
	}
	if err := h.sendToClient(target, msg); err != nil && h.logger != nil {
		h.logger.Info("screen_notify_failed", "room_id", roomID, "action", action)
	}
}

// errClientGone is returned by sendToClient for a connection not on this
// process.
var errClientGone = errors.New("client not connected")

// sendToClient writes one asynchronous message to a single connection. The
// hub keeps its own client map (filled in RegisterClient, cleared on
// disconnect) so the per-signal path does not copy centrifuge's whole
// connection map. Only connections on this process are reachable, which is
// every connection today (ADR-0006); a broker (#244) has to move signaling
// to server-side personal channels first.
func (h *Hub) sendToClient(clientID string, data []byte) error {
	if h.sendFn != nil { // test seam
		return h.sendFn(clientID, data)
	}
	h.clientsMu.RLock()
	c, ok := h.clients[clientID]
	h.clientsMu.RUnlock()
	if !ok {
		return errClientGone
	}
	return c.Send(data)
}

// trackClient adds a connection to the hub client map.
func (h *Hub) trackClient(c *centrifuge.Client) {
	h.clientsMu.Lock()
	h.clients[c.ID()] = c
	h.clientsMu.Unlock()
}

// untrackClient drops a connection from the hub client map.
func (h *Hub) untrackClient(clientID string) {
	h.clientsMu.Lock()
	delete(h.clients, clientID)
	h.clientsMu.Unlock()
}
