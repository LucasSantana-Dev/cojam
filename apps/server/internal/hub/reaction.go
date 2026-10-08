package hub

import (
	"encoding/json"
	"fmt"
	"time"
)

// Reactions ("Modo palco", part 2): a member presses Curtir on the playing
// track and everyone sees their character woot (jump with arms up). The
// reaction is ephemeral by design: nothing is stored, it never enters
// queue.RoomState (no Version bump, no store write) and a late joiner never
// sees past reactions. reaction.woot is membership gated (mutatingMethods) and
// draws from its own per-caller bucket (reactionMethods), so it cannot be
// scripted into a flood and never spends the caller's chat budget. The payload names the connection only; who that is comes from
// presence, never from client params.

// Defaults for the reaction limiter. The client already cools Curtir down for
// 1.5 s; the bucket is the server-side cap for scripted callers. Tests replace
// h.reactionLimiter with a shrunken limiter instead of tuning these.
const (
	reactionBurst  = 4
	reactionRefill = time.Second
)

// reactionMethods draw from reactionLimiter, not the chat bucket.
var reactionMethods = map[string]bool{
	"reaction.woot": true,
}

// checkReactionLimit enforces the per-caller reaction bucket. Returns nil for
// other methods.
func (h *Hub) checkReactionLimit(method, rlKey string) error {
	if !reactionMethods[method] || h.reactionLimiter == nil {
		return nil
	}
	if !h.reactionLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// reactionWoot handles reaction.woot: re-check membership for the
// transport-independent path (Authorize enforces it at the transport) and
// broadcast one reaction.woot event on the room channel.
func (h *Hub) reactionWoot(roomID, clientID string) (json.RawMessage, error) {
	if clientID == "" || !h.IsMember(clientID, roomID) {
		return nil, userErrorf("not a member of this room")
	}
	if err := h.publishWoot(roomID, clientID); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]string{"clientId": clientID})
}

// publishWoot broadcasts one reaction.woot event on the room channel.
func (h *Hub) publishWoot(roomID, clientID string) error {
	return h.publishReaction(roomID, map[string]string{"type": "reaction.woot", "clientId": clientID})
}

// Emotes ("Reagir" in modo palco, part 3): a member sends one of a fixed set
// of emotes and everyone sees it in a bubble over that member's character.
// Same contract as reaction.woot (ephemeral, membership gated, names the
// connection only), plus a strict allowlist and one emote per emoteInterval
// per connection, on its own limiter.
const emoteInterval = 600 * time.Millisecond

var allowedEmotes = map[string]bool{
	"amei": true, "fogo": true, "rindo": true, "palmas": true, "uau": true, "cantando": true,
}

// reactionEmote handles reaction.emote: membership, the allowlist (a bad emote
// spends no token), the per-connection limit, then one broadcast.
func (h *Hub) reactionEmote(roomID, clientID, emote string) (json.RawMessage, error) {
	if clientID == "" || !h.IsMember(clientID, roomID) {
		return nil, userErrorf("not a member of this room")
	}
	if !allowedEmotes[emote] {
		return nil, userErrorf("unknown emote")
	}
	if h.emoteLimiter != nil && !h.emoteLimiter.allow("client:"+clientID) {
		if h.metrics != nil {
			h.metrics.RateLimitReject("reaction.emote")
		}
		return nil, userErrorf("too many requests, slow down")
	}
	if err := h.publishReaction(roomID, map[string]string{"type": "reaction.emote", "clientId": clientID, "emote": emote}); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]string{"clientId": clientID, "emote": emote})
}

// publishReaction broadcasts one reaction event on the room channel. The
// wootPublishFn seam lets tests observe the payload; a nil node (tests without
// the seam) skips, like publishCharacter.
func (h *Hub) publishReaction(roomID string, event map[string]string) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if h.wootPublishFn != nil {
		return h.wootPublishFn(roomID, payload)
	}
	if h.node == nil {
		return nil
	}
	if _, err = h.node.Publish("room:"+roomID, payload); err != nil {
		if h.metrics != nil {
			h.metrics.PublishError()
		}
		return fmt.Errorf("publish %s: %w", event["type"], err)
	}
	return nil
}
