package main

import (
	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
)

// authorizeSubscribe admits a subscription only to a "room:<id>" channel with
// a well-formed room id, and enrolls the client as a member of that room
// (link = capability; see docs/protocol.md "Trust model", #180). centrifuge
// re-subscribes on reconnect, so membership survives reconnects. Every other
// channel is refused, so clients cannot open arbitrary channels with presence.
func authorizeSubscribe(h *hub.Hub, clientID, channel string) (centrifuge.SubscribeReply, error) {
	roomID, ok := hub.RoomIDFromChannel(channel)
	if !ok {
		return centrifuge.SubscribeReply{}, centrifuge.ErrorPermissionDenied
	}
	h.Join(clientID, roomID)
	// Presence + join/leave so the room can show who is listening.
	return centrifuge.SubscribeReply{
		Options: centrifuge.SubscribeOptions{
			EmitPresence:  true,
			EmitJoinLeave: true,
			PushJoinLeave: true,
		},
	}, nil
}
