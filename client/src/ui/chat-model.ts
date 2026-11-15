// Chat em balões (fork secoondsz): a lógica pura de ui/chat.ts. A conversa vem do mesmo stream do terminal
// (TerminalEntry); aqui ela vira balões estilo WhatsApp: o que você mandou à direita, as respostas do agente à
// esquerda e as ferramentas agrupadas num aviso pequeno ("trabalhando: lendo, pesquisando · 4 ações").
import type { AgentInfo, TerminalEntry } from '../../../shared/types';

/** Linha que a mensagem leva para cada foto anexada (o agente lê o caminho; o chat mostra a miniatura). */
export const PHOTO_PREFIX = '📎 Foto anexada: ';
const PHOTO_LINE = /^📎 Foto anexada: (anexos\/[^\s]+)\s*$/;
/** Pedido que vai junto quando só há fotos, sem texto. */
export const PHOTO_ONLY_TEXT = 'Analise as fotos que mandei.';

/** Um passo do trabalho (ferramenta) e o começo do resultado, para abrir o aviso e ver o detalhe. */
export interface WorkStep {
  id: string;
  title: string;
  result?: string;
  error?: boolean;
}

export type ChatItem =
  | { type: 'me'; id: string; at: number; text: string; photos: string[] }
  | { type: 'agent'; id: string; at: number; text: string }
  | { type: 'work'; id: string; at: number; labels: string[]; count: number; steps: WorkStep[] }
  | { type: 'note'; id: string; at: number; text: string; level: 'info' | 'warn' | 'error' };

/** Separa as linhas de foto do texto da mensagem. */
export function splitPhotos(raw: string): { text: string; photos: string[] } {
  const photos: string[] = [];
  const rest: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = PHOTO_LINE.exec(line.trim());
    if (m) photos.push(m[1]);
    else rest.push(line);
  }
  return { text: rest.join('\n').trim(), photos };
}

/** Texto que vai para o agente: o que você escreveu e uma linha por foto. */
export function chatMessage(text: string, photos: readonly string[]): string {
  const body = text.trim() || (photos.length ? PHOTO_ONLY_TEXT : '');
  return [body, ...photos.map((p) => PHOTO_PREFIX + p)].filter(Boolean).join('\n');
}

const TOOL_LABELS: Array<[RegExp, string]> = [
  [/chrome|browser/i, 'usando o navegador'],
  [/^(Read|NotebookRead)$/, 'lendo'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'escrevendo'],
  [/^(Glob|Grep|LS)$/, 'procurando'],
  [/^(Bash|PowerShell|BashOutput)$/, 'rodando um comando'],
  [/^WebSearch$/, 'pesquisando na web'],
  [/^WebFetch$/, 'abrindo uma página'],
  [/^(Agent|Task)$/, 'chamando um especialista'],
  [/^(TodoWrite|TaskCreate|TaskUpdate)$/, 'organizando as tarefas'],
  [/^AskUserQuestion$/, 'perguntando'],
];

/** Nome amigável da ferramenta pelo título "Read(arquivo)" / "mcp__x__y(...)". */
export function toolLabel(title: string): string {
  const name = title.split('(')[0].trim();
  for (const [re, label] of TOOL_LABELS) if (re.test(name)) return label;
  return 'trabalhando';
}

/** Os balões da conversa, na ordem. Ferramentas seguidas viram um aviso só; raciocínio e resultados ficam de fora. */
export function chatItems(entries: readonly TerminalEntry[]): ChatItem[] {
  const out: ChatItem[] = [];
  const steps = new Map<string, WorkStep>();
  for (const e of entries) {
    if (e.kind === 'user') {
      // Demanda que chegou de outra sala (o escritório digitou): aparece como aviso de bastão.
      if (e.text.startsWith('📨')) {
        out.push({ type: 'note', id: e.id, at: e.at, text: e.text.split(':')[0].replace(/^📨\s*/, '📨 ') + ' — entregue', level: 'info' });
        continue;
      }
      const { text, photos } = splitPhotos(e.text);
      if (!text && !photos.length) continue;
      out.push({ type: 'me', id: e.id, at: e.at, text, photos });
    } else if (e.kind === 'assistant') {
      if (!e.text.trim()) continue;
      out.push({ type: 'agent', id: e.id, at: e.at, text: e.text });
    } else if (e.kind === 'tool') {
      const label = toolLabel(e.title);
      const step: WorkStep = { id: e.id, title: e.title };
      steps.set(e.id, step);
      const last = out[out.length - 1];
      if (last?.type === 'work') {
        last.count++;
        last.steps.push(step);
        if (!last.labels.includes(label)) last.labels.push(label);
      } else out.push({ type: 'work', id: e.id, at: e.at, labels: [label], count: 1, steps: [step] });
    } else if (e.kind === 'result') {
      const step = steps.get(e.toolUseId);
      if (step) {
        step.result = e.text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 4).join('\n').slice(0, 400);
        step.error = e.error;
      }
    } else if (e.kind === 'system' && (e.level === 'warn' || e.level === 'error')) {
      out.push({ type: 'note', id: e.id, at: e.at, text: e.text, level: e.level });
    }
  }
  return out;
}

/** Assinatura do balão: mudou = redesenha (o aviso de trabalho cresce enquanto o agente usa ferramentas). */
export function itemSignature(item: ChatItem): string {
  switch (item.type) {
    case 'me':
      return `me|${item.text}|${item.photos.join(',')}`;
    case 'agent':
      return `ag|${item.text}`;
    case 'work':
      return `wk|${item.labels.join(',')}|${item.count}|${item.steps.map((st) => (st.result === undefined ? 0 : 1)).join('')}`;
    case 'note':
      return `nt|${item.text}`;
  }
}

/** Texto do aviso de trabalho: "lendo, pesquisando na web · 4 ações". */
export function workText(item: Extract<ChatItem, { type: 'work' }>): string {
  const labels = item.labels.slice(0, 3).join(', ') + (item.labels.length > 3 ? '…' : '');
  return item.count > 1 ? `${labels} · ${item.count} ações` : labels;
}

/** Linha embaixo do nome (como o "digitando…" do WhatsApp). */
export function presence(agent: AgentInfo | undefined): { text: string; tone: 'typing' | 'alert' | 'online' | 'off' } {
  if (!agent || agent.status === 'offline' || agent.status === 'done') return { text: 'conversa encerrada', tone: 'off' };
  if (agent.permission || agent.status === 'waiting') return { text: 'precisa de você', tone: 'alert' };
  if (agent.status === 'working' || agent.status === 'shell') {
    const act = agent.activity?.text;
    return { text: act ? `${act.charAt(0).toLowerCase()}${act.slice(1)}…` : 'digitando…', tone: 'typing' };
  }
  return { text: 'online', tone: 'online' };
}

/** Hora "14:05" do balão. */
export function bubbleTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Texto curto para a lista de conversas. */
export function preview(items: readonly ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'agent') return it.text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (it.type === 'me') return `Você: ${it.text || '📷 Foto'}`.replace(/\s+/g, ' ').slice(0, 60);
  }
  return '';
}

/** A mensagem pendente (ainda não está no transcript) já apareceu na conversa? */
export function pendingArrived(sentText: string, sentAt: number, items: readonly ChatItem[]): boolean {
  const want = splitPhotos(sentText);
  const key = want.text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return items.some(
    (it) =>
      it.type === 'me' &&
      it.at >= sentAt - 60_000 &&
      it.text.replace(/\s+/g, ' ').trim().slice(0, 80) === key &&
      it.photos.length === want.photos.length,
  );
}

export type ChatSegment = { kind: 'md'; text: string } | { kind: 'table'; rows: string[][] };

const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Separa as tabelas markdown (cabeçalho + linha de traços + linhas) do resto do texto. */
export function splitTables(src: string): ChatSegment[] {
  const lines = src.split(/\r?\n/);
  const out: ChatSegment[] = [];
  let md: string[] = [];
  const flush = () => {
    if (md.join('').trim()) out.push({ kind: 'md', text: md.join('\n') });
    md = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())) {
      flush();
      const rows = [cells(lines[i])];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      i--;
      out.push({ kind: 'table', rows });
    } else md.push(lines[i]);
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ sessão de verdade (terminal interativo)

/** O que digitar no terminal para mandar o texto: uma linha vai direto; várias vão coladas (bracketed paste). */
export function ptyTyping(text: string): string {
  return /\n/.test(text) ? `\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~` : text;
}

/** Teclas do Claude Code. */
export const KEY_ENTER = '\r';
export const KEY_ESC = '\x1b';
export const KEY_SHIFT_TAB = '\x1b[Z';

/** Nome do modo de permissão em português. */
export function modeLabel(mode: string | undefined): string {
  switch (mode) {
    case 'acceptEdits':
      return 'aceita edições';
    case 'plan':
      return 'modo plano';
    case 'bypassPermissions':
      return 'sem pedir nada';
    case 'auto':
      return 'automático';
    case 'default':
    case undefined:
    case '':
      return 'pede permissão';
    default:
      return mode;
  }
}

export interface SlashCommand {
  cmd: string;
  text: string;
  /** Abre um menu no terminal: o chat abre a janela do terminal junto. */
  menu?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/clear', text: 'começar uma conversa nova (limpa tudo)' },
  { cmd: '/compact', text: 'resumir a conversa para liberar espaço' },
  { cmd: '/context', text: 'quanto da memória da conversa está em uso' },
  { cmd: '/usage', text: 'seu limite de uso agora' },
  { cmd: '/model sonnet', text: 'trocar para o Sonnet (mais barato)' },
  { cmd: '/model opus', text: 'trocar para o Opus (mais forte)' },
  { cmd: '/model', text: 'escolher o modelo', menu: true },
  { cmd: '/resume', text: 'retomar uma conversa antiga', menu: true },
  { cmd: '/permissions', text: 'regras de permissão', menu: true },
  { cmd: '/agents', text: 'especialistas da sala', menu: true },
  { cmd: '/mcp', text: 'conectores', menu: true },
  { cmd: '/config', text: 'configurações', menu: true },
];

/** Comandos que combinam com o que está sendo digitado ("/" sozinho = todos). */
export function slashMatches(typed: string): SlashCommand[] {
  const t = typed.trim().toLowerCase();
  if (!t.startsWith('/') || /\s/.test(typed.trimStart().slice(1).replace(/^(model)\s.*$/, '$1')) && !t.startsWith('/model')) return [];
  return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(t) && c.cmd !== t);
}

/** O comando digitado abre um menu no terminal? */
export function opensMenu(text: string): boolean {
  const t = text.trim();
  return SLASH_COMMANDS.some((c) => c.menu && c.cmd === t);
}

/** Mesma pasta (Windows: sem diferença de maiúsculas nem de barra). */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  const n = (p: string | undefined) => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && n(a) === n(b);
}

/**
 * O modo de permissão que o rodapé do Claude Code mostra agora ("⏸ plan mode on", "⏵⏵ accept edits on"...). O
 * transcript só registra a troca quando chega a próxima mensagem; a tela mostra na hora. undefined = não deu para ler.
 */
export function modeFromScreen(screen: string): string | undefined {
  const clean = screen
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return undefined;
  // Janela de aprovação ou menu aberto no terminal: o rodapé de modo não está na tela.
  if (/esc to cancel|do you want to proceed|enter to (select|confirm)/i.test(lines.slice(-8).join(' '))) return undefined;
  const foot = lines.slice(-3).join(' ').toLowerCase();
  if (/plan mode on/.test(foot)) return 'plan';
  if (/accept edits on/.test(foot)) return 'acceptEdits';
  if (/auto mode on/.test(foot)) return 'auto';
  if (/bypass permissions on/.test(foot)) return 'bypassPermissions';
  // Rodapé visível (caixa de digitação) sem aviso de modo = o modo padrão (pede permissão).
  return /[❯>]|for shortcuts|─{10,}/.test(foot) ? 'default' : undefined;
}
