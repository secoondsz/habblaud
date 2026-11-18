// Fotos do chat (fork secoondsz). O chat em balões manda fotos junto com a mensagem: elas são gravadas DENTRO da pasta
// da sala, em anexos/AAAA-MM-DD/<nome>, para o agente abrir com o Read sem pedir permissão (fica no projeto dele). A
// mensagem leva o caminho relativo numa linha "📎 Foto anexada: anexos/...", que o chat troca pela miniatura.
//
//   POST /api/chat/files   {agentId, name, type?, data (base64)}  201 {path}
//   GET  /api/chat/file?room=<roomId>&p=<caminho>                 a imagem (só imagens, só dentro da pasta da sala)
//
// O GET também mostra no chat as imagens que o agente cita na resposta (um print salvo em campanhas/, por exemplo):
// qualquer imagem dentro da pasta da sala, nunca fora dela (nem por link simbólico).
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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

/** Imagem maior que isto não vai para o chat. */
const READ_MAX = 25 * 1024 * 1024;

/** Lê uma imagem da sala para o chat: só caminhos relativos dentro da pasta da sala e só imagens. */
export function readChatFile(roomPath: string, rel: string): { data: Buffer; type: string } | null {
  if (!rel || rel.includes('\0') || /^[\\/]|^[a-z]:/i.test(rel)) return null;
  const type = IMAGE_TYPES[extname(rel).toLowerCase()];
  if (!type) return null;
  try {
    const root = realpathSync(resolve(roomPath));
    const full = realpathSync(resolve(roomPath, ...rel.split(/[\\/]/)));
    if (!full.startsWith(root + sep)) return null;
    const st = statSync(full);
    if (!st.isFile() || st.size > READ_MAX) return null;
    return { data: readFileSync(full), type };
  } catch {
    return null;
  }
}
