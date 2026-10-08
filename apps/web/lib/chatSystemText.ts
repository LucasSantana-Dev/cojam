// System chat lines persisted before the PT-BR switch are English
// ("Luk joined", "Now playing: X — Y"). Render them in Portuguese; new lines
// from the server are already Portuguese and pass through untouched.
export function ptSystemText(text: string): string {
  const playing = /^Now playing: (.+?) — (.*)$/.exec(text);
  if (playing) return `Tocando agora: ${playing[1]}, de ${playing[2]}`;
  const member = /^(.+) (joined|left)$/.exec(text);
  if (member) return `${member[1] === 'Someone' ? 'Alguém' : member[1]} ${member[2] === 'joined' ? 'entrou' : 'saiu'}`;
  return text;
}
