import { ptSystemText } from './chatSystemText';

// Join, leave and screen share notices pile up fast (a reconnecting phone can
// post a dozen in a minute) and push the conversation out of view. A run of
// them collapses into its latest line plus "+N", which opens the rest.

const PRESENCE = / (entrou|saiu|começou a compartilhar a tela|parou de compartilhar a tela)$/;

export function isPresenceLine(text: string): boolean {
  return PRESENCE.test(ptSystemText(text));
}

type ChatLike = { id: string; kind?: string; text: string };

export type ChatItem<T> = { kind: 'one'; msg: T } | { kind: 'run'; id: string; msgs: T[] };

// MIN_RUN is the shortest run that collapses: one or two notices read fine.
export const MIN_RUN = 3;

export function groupPresence<T extends ChatLike>(chat: T[], minRun = MIN_RUN): ChatItem<T>[] {
  const out: ChatItem<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length >= minRun) out.push({ kind: 'run', id: run[0].id, msgs: run });
    else for (const msg of run) out.push({ kind: 'one', msg });
    run = [];
  };
  for (const m of chat) {
    if (m.kind === 'system' && isPresenceLine(m.text)) run.push(m);
    else {
      flush();
      out.push({ kind: 'one', msg: m });
    }
  }
  flush();
  return out;
}
