package hub

import (
	"encoding/json"
	"fmt"
)

// Reactions ("Modo palco", part 2): a member presses Curtir on the playing
// track and everyone sees their character woot (jump with arms up). The
// reaction is ephemeral by design: nothing is stored, it never enters
// queue.RoomState (no Version bump, no store write) and a late joiner never
// sees past reactions. reaction.woot is membership gated (mutatingMethods) and
// draws from the chat limiter (chatMethods), so it cannot be scripted into a
// flood. The payload names the connection only; who that is comes from
// presence, never from client params.

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

// publishWoot broadcasts one reaction.woot event on the room channel. The
// wootPublishFn seam lets tests observe the payload; a nil node (tests without
// the seam) skips, like publishCharacter.
func (h *Hub) publishWoot(roomID, clientID string) error {
	payload, err := json.Marshal(map[string]string{"type": "reaction.woot", "clientId": clientID})
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
		return fmt.Errorf("publish reaction.woot: %w", err)
	}
	return nil
}
