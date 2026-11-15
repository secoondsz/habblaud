// Fotos do chat (fork secoondsz). O chat em balões manda fotos junto com a mensagem: elas são gravadas DENTRO da pasta
// da sala, em anexos/AAAA-MM-DD/<nome>, para o agente abrir com o Read sem pedir permissão (fica no projeto dele). A
// mensagem leva o caminho relativo numa linha "📎 Foto anexada: anexos/...", que o chat troca pela miniatura.
//
//   POST /api/chat/files   {agentId, name, type?, data (base64)}  201 {path}
//   GET  /api/chat/file?room=<roomId>&p=<anexos/...>             a imagem (só imagens, só dentro de anexos/)
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Attachment } from '../spawn/attachments';

export const CHAT_DIR = 'anexos';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function day(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Extensão a partir do tipo, quando o nome não tem (print colado vem como "image.png", mas por garantia). */
function withExt(name: string, type: string): string {
  if (extname(name)) return name;
  const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === type)?.[0];
  return ext ? name + ext : name;
}

/** Grava a foto em <sala>/anexos/AAAA-MM-DD/ sem sobrescrever; devolve o caminho relativo com "/". */
export function saveChatFile(roomPath: string, a: Attachment, now = new Date()): string {
  const folder = `${CHAT_DIR}/${day(now)}`;
  const dir = join(roomPath, ...folder.split('/'));
  mkdirSync(dir, { recursive: true });
  const name = withExt(a.name, a.type);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let file = name;
  for (let i = 2; existsSync(join(dir, file)); i++) file = `${base}-${i}${ext}`;
  writeFileSync(join(dir, file), a.data);
  return `${folder}/${file}`;
}

/** Lê uma foto do chat: só caminhos relativos dentro de <sala>/anexos/ e só imagens. */
export function readChatFile(roomPath: string, rel: string): { data: Buffer; type: string } | null {
  if (!rel || rel.includes('\0') || /^[\\/]|^[a-z]:/i.test(rel)) return null;
  const root = resolve(roomPath, CHAT_DIR);
  const full = resolve(roomPath, ...rel.split(/[\\/]/));
  if (!full.startsWith(root + sep)) return null;
  const type = IMAGE_TYPES[extname(full).toLowerCase()];
  if (!type) return null;
  try {
    if (!statSync(full).isFile()) return null;
    return { data: readFileSync(full), type };
  } catch {
    return null;
  }
}
