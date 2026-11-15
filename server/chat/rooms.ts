// Salas fixas do escritório (fork secoondsz): as conversas de cada sala e o arquivo delas.
//
// - roomSessions: as conversas (transcripts) já gravadas na pasta da sala, da mais recente para a mais antiga. É o que
//   faz "Conversar" retomar a conversa da sala em vez de abrir outra do zero.
// - ConversationArchive: copia cada conversa para <sala>/conversas/AAAA-MM-DD-<id>.md, em texto legível. O Claude Code
//   apaga transcripts antigos sozinho (30 dias, por padrão) e um /clear começa outro: a cópia fica. Sala com
//   "<!-- arquivo: nao -->" no CLAUDE.md fica de fora (ex.: Pedidos, que tem dados de clientes).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TerminalEntry } from '../../shared/types';
import { errMsg, log } from '../log';
import { createTerminalParser } from '../sources/terminal';
import { encodeCwd } from '../sources/watcher';

export interface ConfigDir {
  /** Id da conta (AccountEntry.id). */
  account: string;
  /** Config dir do Claude Code (o que tem projects/). */
  dir: string;
}

export interface RoomSession {
  account: string;
  sessionId: string;
  file: string;
  mtimeMs: number;
  size: number;
}

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Transcript maior que isto não é arquivado de uma vez (lê só o fim). */
const ARCHIVE_MAX_BYTES = 40 * 1024 * 1024;

/** Conversas gravadas na pasta da sala, da mais recente para a mais antiga. */
export function roomSessions(dirs: readonly ConfigDir[], roomPath: string): RoomSession[] {
  const out: RoomSession[] = [];
  const enc = encodeCwd(roomPath);
  for (const { account, dir } of dirs) {
    const projects = join(dir, 'projects');
    let folders: string[];
    try {
      // No Windows a pasta pode ter vindo com outra caixa (c:\ x C:\): compara sem diferenciar.
      folders = readdirSync(projects).filter((f) => f.toLowerCase() === enc.toLowerCase());
    } catch {
      continue;
    }
    for (const folder of folders) {
      let files: string[];
      try {
        files = readdirSync(join(projects, folder));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = SESSION_FILE.exec(f);
        if (!m) continue;
        try {
          const st = statSync(join(projects, folder, f));
          if (st.size > 0) out.push({ account, sessionId: m[1], file: join(projects, folder, f), mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* sumiu no meio */
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A conversa da sala que deve continuar (a mais recente com alguma mensagem sua). */
export function lastRoomSession(dirs: readonly ConfigDir[], roomPath: string): RoomSession | undefined {
  return roomSessions(dirs, roomPath)[0];
}

/** Entradas do transcript (o mesmo parser do terminal). */
export function readEntries(file: string, maxBytes = ARCHIVE_MAX_BYTES): TerminalEntry[] {
  let raw = readFileSync(file, 'utf8');
  if (raw.length > maxBytes) raw = raw.slice(raw.length - maxBytes).replace(/^[^\n]*\n/, '');
  const parser = createTerminalParser();
  const out: TerminalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(...parser.push(line));
    } catch {
      /* linha estranha: pula */
    }
  }
  return out;
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A conversa em markdown: o que você mandou, o que o agente respondeu e o resumo do que ele fez. */
export function conversationMarkdown(roomName: string, sessionId: string, entries: readonly TerminalEntry[]): string {
  const first = entries.find((e) => e.at)?.at ?? Date.now();
  const lines: string[] = [
    '---',
    `sala: ${roomName}`,
    `sessao: ${sessionId}`,
    `dia: ${dayOf(first)}`,
    'tipo: conversa',
    '---',
    '',
    `# ${roomName} — conversa de ${dayOf(first).split('-').reverse().join('/')}`,
    '',
  ];
  let tools: string[] = [];
  const flush = () => {
    if (!tools.length) return;
    lines.push(`> ⚙ ${tools.length} ${tools.length === 1 ? 'ação' : 'ações'}: ${tools.slice(0, 8).join(' · ')}${tools.length > 8 ? ' …' : ''}`, '');
    tools = [];
  };
  for (const e of entries) {
    if (e.kind === 'tool') tools.push(e.title.replace(/\s+/g, ' ').slice(0, 80));
    else if (e.kind === 'user') {
      flush();
      lines.push(`**Davi** (${hhmm(e.at)}):`, '', e.text.trim(), '');
    } else if (e.kind === 'assistant' && e.text.trim()) {
      flush();
      lines.push(`**Agente** (${hhmm(e.at)}):`, '', e.text.trim(), '');
    } else if (e.kind === 'system' && (e.level === 'warn' || e.level === 'error')) {
      flush();
      lines.push(`> ⚠ ${e.text}`, '');
    }
  }
  flush();
  return lines.join('\n');
}

/** A sala pediu para ficar fora do arquivo ("<!-- arquivo: nao -->" no CLAUDE.md). */
export function archiveDisabled(roomPath: string): boolean {
  try {
    return /<!--\s*arquivo\s*:\s*n[aã]o\s*-->/i.test(readFileSync(join(roomPath, 'CLAUDE.md'), 'utf8').slice(0, 4000));
  } catch {
    return false;
  }
}

export interface ArchiveOptions {
  rooms: () => readonly string[];
  dirs: () => readonly ConfigDir[];
  roomName: (path: string) => string;
  intervalMs?: number;
}

/** Copia as conversas das salas para <sala>/conversas/ (só as que mudaram desde a última passada). */
export class ConversationArchive {
  private seen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private o: ArchiveOptions) {}

  start(): void {
    if (this.timer) return;
    setTimeout(() => this.tick(), 5_000).unref?.();
    this.timer = setInterval(() => this.tick(), this.o.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma passada (exposta para os testes). Devolve os arquivos gravados. */
  tick(): string[] {
    const written: string[] = [];
    for (const room of this.o.rooms()) {
      if (archiveDisabled(room)) continue;
      for (const s of roomSessions(this.o.dirs(), room)) {
        if (this.seen.get(s.file) === s.mtimeMs) continue;
        try {
          const entries = readEntries(s.file);
          const talk = entries.filter((e) => e.kind === 'user' || e.kind === 'assistant');
          this.seen.set(s.file, s.mtimeMs);
          if (!talk.length) continue;
          const first = entries.find((e) => e.at)?.at ?? s.mtimeMs;
          const dir = join(room, 'conversas');
          const out = join(dir, `${dayOf(first)}-${s.sessionId.slice(0, 8)}.md`);
          if (existsSync(out) && statSync(out).mtimeMs >= s.mtimeMs) continue;
          mkdirSync(dir, { recursive: true });
          writeFileSync(out, conversationMarkdown(this.o.roomName(room), s.sessionId, entries));
          written.push(out);
        } catch (err) {
          log.warnOnce(`archive:${basename(s.file)}`, `Arquivo das conversas: falhou em ${s.file} (${errMsg(err)}).`);
        }
      }
    }
    return written;
  }
}
