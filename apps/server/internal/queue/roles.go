package queue

// MaxAdmins caps the admin list so a room state stays bounded.
const MaxAdmins = 20

// IsAdmin reports whether userID is in the room's admin list.
func (rs *RoomState) IsAdmin(userID string) bool {
	if userID == "" {
		return false
	}
	for _, a := range rs.Admins {
		if a == userID {
			return true
		}
	}
	return false
}

// CanControl reports whether userID holds queue and transport control: the
// host, the owner or an admin. It is the single permission predicate behind
// every queue and transport RPC. An empty userID never matches.
func (rs *RoomState) CanControl(userID string) bool {
	if userID == "" {
		return false
	}
	return userID == rs.HostUserID || userID == rs.OwnerUserID || rs.IsAdmin(userID)
}

// IsHostOrOwner reports whether userID may manage roles (set_admin,
// transfer_host) and moderate (kick, public flag).
func (rs *RoomState) IsHostOrOwner(userID string) bool {
	return userID != "" && (userID == rs.HostUserID || userID == rs.OwnerUserID)
}

// SetAdmin adds or removes userID from the admin list and reports whether
// anything changed. It does not bump Version; the caller does when changed.
func (rs *RoomState) SetAdmin(userID string, admin bool) (changed bool, full bool) {
	for i, a := range rs.Admins {
		if a != userID {
			continue
		}
		if admin {
			return false, false
		}
		rs.Admins = append(rs.Admins[:i], rs.Admins[i+1:]...)
		if len(rs.Admins) == 0 {
			rs.Admins = nil
		}
		return true, false
	}
	if !admin {
		return false, false
	}
	if len(rs.Admins) >= MaxAdmins {
		return false, true
	}
	rs.Admins = append(rs.Admins, userID)
	return true, false
}

// HasSource reports whether the track carries any playable source.
func (t *TrackRef) HasSource() bool {
	return t.Sources.YouTube != nil || t.Sources.Spotify != nil
}

// Track returns the queued track with the given ID, or nil.
func (rs *RoomState) Track(id string) *TrackRef {
	for i := range rs.Queue {
		if rs.Queue[i].ID == id {
			return &rs.Queue[i]
		}
	}
	return nil
}
