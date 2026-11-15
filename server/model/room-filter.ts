// Módulo do escritório de agentes (fork secoondsz/habblaud): quais salas aparecem e com que nome.
//
// - HABBLAUD_SALAS: pastas separadas por ";" (ex.: "~/Documents/escritorio"). Com ela definida, só entram no
//   escritório as sessões abertas DENTRO dessas pastas; as outras conversas do Claude Code no computador (assistente
//   pessoal, testes, instalações) ficam de fora. Sem ela, tudo entra, como no Habblaud original.
//   Uma sessão fora das pastas também não desvia pedidos de permissão para o escritório: o registro de permissões não
//   a conhece e devolve `skip: unknown-session`, então o pedido segue no terminal dela.
// - Nome da operação: a sala de uma pasta cujo CLAUDE.md começa com "# Operação: Tráfego pago" se chama
//   "Tráfego pago" (quando o usuário não renomeou a sala).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAME_POOL } from '../../shared/names';
import { pathKey } from './room-aliases';

/** Decide se a sessão aberta em `cwd` entra no escritório. */
export type RoomFilter = (cwd: string) => boolean;

/** Pastas de HABBLAUD_SALAS, com "~" e %USERPROFILE% trocados pela pasta pessoal. Vazio = sem filtro. */
export function parseRoomFolders(raw: string | undefined, home: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[;\n]+/)
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
    .map((p) => p.replace(/^~(?=$|[\\/])/, home).replace(/%USERPROFILE%/gi, home));
}

/** Filtro das salas: a pasta da sessão é uma das pastas ou fica dentro de uma delas. */
export function makeRoomFilter(folders: readonly string[]): RoomFilter {
  const keys = folders.map(pathKey).filter(Boolean);
  if (!keys.length) return () => true;
  return (cwd) => {
    const k = pathKey(cwd);
    return keys.some((f) => k === f || k.startsWith(`${f}/`));
  };
}

const HEADING = /^#[ \t]*Opera(?:ç|c)(?:ã|a)o[ \t]*:[ \t]*(.+?)[ \t]*$/im;
const NAME_MAX = 40;

/** Nome da operação no começo do CLAUDE.md da pasta ("# Operação: X"), se houver. */
export function operationNameFromText(text: string): string | undefined {
  const head = text.slice(0, 2_000);
  const m = HEADING.exec(head);
  const name = m?.[1]?.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, NAME_MAX) : undefined;
}

/** Lê o nome da operação da pasta, com cache por pasta (vale até reiniciar o servidor). */
export function createOperationNames(read: (file: string) => string = (f) => readFileSync(f, 'utf8')): (path: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (path) => {
    const k = pathKey(path);
    if (cache.has(k)) return cache.get(k);
    let name: string | undefined;
    try {
      name = operationNameFromText(read(join(path, 'CLAUDE.md')));
    } catch {
      name = undefined;
    }
    cache.set(k, name);
    return name;
  };
}

/** O que createPinnedRooms precisa do disco (injetável nos testes). */
export interface PinnedFs {
  /** Subpastas diretas de `dir` (só os nomes). */
  subdirs: (dir: string) => string[];
  exists: (file: string) => boolean;
  /** Começo do arquivo (para a ordem da sala); ausente = sem ordem. */
  read?: (file: string) => string;
}

const realFs: PinnedFs = {
  subdirs: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
      .map((d) => d.name),
  exists: (file) => existsSync(file),
  read: (file) => readFileSync(file, 'utf8').slice(0, 2_000),
};

const ORDER = /<!--\s*ordem\s*:\s*(\d+)\s*-->/i;

/** Ordem da sala no prédio: `<!-- ordem: 3 -->` no CLAUDE.md da operação; sem ela, depois das numeradas. */
export function roomOrderFromText(text: string): number | undefined {
  const m = ORDER.exec(text.slice(0, 2_000));
  return m ? Number(m[1]) : undefined;
}

/**
 * Salas fixas: cada subpasta direta de uma pasta de HABBLAUD_SALAS que tenha CLAUDE.md é uma operação e vira uma sala
 * permanente no prédio. Relê o disco no máximo a cada `ttlMs`, para uma operação nova aparecer sem reiniciar.
 */
export function createPinnedRooms(folders: readonly string[], opts: { ttlMs?: number; now?: () => number; fs?: PinnedFs } = {}): () => string[] {
  const ttl = opts.ttlMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const fs = opts.fs ?? realFs;
  let cache: string[] = [];
  let at = -Infinity;
  return () => {
    if (!folders.length) return [];
    const t = now();
    if (t - at < ttl) return cache;
    at = t;
    const found: { dir: string; name: string; order: number }[] = [];
    for (const base of folders) {
      let names: string[];
      try {
        names = fs.subdirs(base);
      } catch {
        continue;
      }
      for (const name of names) {
        const dir = join(base, name);
        const file = join(dir, 'CLAUDE.md');
        if (!fs.exists(file)) continue;
        let order: number | undefined;
        try {
          order = fs.read ? roomOrderFromText(fs.read(file)) : undefined;
        } catch {
          order = undefined;
        }
        found.push({ dir, name, order: order ?? Number.MAX_SAFE_INTEGER });
      }
    }
    // A ordem decide as vagas no prédio (a primeira sala pega a primeira vaga).
    cache = found.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((f) => f.dir);
    return cache;
  };
}

const AGENT_RE = /<!--\s*agente\s*:\s*([^,>]+?)\s*(?:,\s*([fm]))?\s*-->/i;

/** Fork: "<!-- agente: Helena -->" (ou "<!-- agente: Léo, m -->") no CLAUDE.md da sala = o agente fixo dela. */
export function roomAgentFromText(text: string): { name: string; look: 'f' | 'm' } | undefined {
  const m = AGENT_RE.exec(text.slice(0, 4000));
  if (!m) return undefined;
  const name = m[1].replace(/[*_`]/g, '').trim().slice(0, 24);
  if (!name) return undefined;
  const look = (m[2]?.toLowerCase() as 'f' | 'm' | undefined) ?? NAME_POOL.find((p) => p.name.toLowerCase() === name.toLowerCase())?.look ?? 'f';
  return { name, look };
}

/** O agente fixo de cada sala (lido do CLAUDE.md, com cache curto). */
export function createRoomAgents(read: (path: string) => string | undefined = (p) => {
  try {
    return readFileSync(join(p, 'CLAUDE.md'), 'utf8');
  } catch {
    return undefined;
  }
}): (path: string) => { name: string; look: 'f' | 'm' } | undefined {
  const cache = new Map<string, { at: number; v: { name: string; look: 'f' | 'm' } | undefined }>();
  return (path) => {
    const key = pathKey(path);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.v;
    const text = read(path);
    const v = text ? roomAgentFromText(text) : undefined;
    cache.set(key, { at: Date.now(), v });
    return v;
  };
}
