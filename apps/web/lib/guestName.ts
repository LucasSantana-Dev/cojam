// The guest display name, shared by the landing form and the room join form.
// Session-scoped on purpose (cleared when the tab closes): the room page
// auto-rejoins with this name, which is also how the landing's "name + create"
// lands the user inside the new room without a second form. Do not build a
// parallel store: RoomClient reads and writes the same key.
export const NAME_KEY = 'mj_room_name';

export function readGuestName(): string {
  try {
    return sessionStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveGuestName(name: string): void {
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage blocked: the room's own form still asks for the name.
  }
}
