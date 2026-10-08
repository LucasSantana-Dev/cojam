// Remove after 2026-11-01. Chat lives in server memory only (it is not
// persisted), so English system lines exist just until rooms that were open
// before the PT-BR switch are recycled. Render them in Portuguese; new lines
// from the server are already Portuguese and pass through untouched.
const LONG_DASH = ' \u2014 ';

export function ptSystemText(text: string): string {
  if (text.startsWith('Tocando agora: ')) return text;
  if (text.startsWith('Now playing: ')) {
    const body = text.slice('Now playing: '.length);
    const at = body.lastIndexOf(LONG_DASH);
    if (at > 0) {
      const title = body.slice(0, at);
      const artist = body.slice(at + LONG_DASH.length).trim();
      return artist ? `Tocando agora: ${title}, de ${artist}` : `Tocando agora: ${title}`;
    }
    return text;
  }
  const member = /^(.+) (joined|left)$/.exec(text);
  if (member) return `${member[1] === 'Someone' ? 'Alguém' : member[1]} ${member[2] === 'joined' ? 'entrou' : 'saiu'}`;
  return text;
}
