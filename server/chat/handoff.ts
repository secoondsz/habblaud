// Passagem de bastão entre salas (fork secoondsz). Uma sala termina a parte dela e, depois do "sim" do Davi, escreve a
// demanda em ../<próxima sala>/caixa-de-entrada/<arquivo>.md. O escritório vê o arquivo e, na hora de entregar, move
// para caixa-de-entrada/recebidas/ (o arquivo só sai da caixa quando é entregue: nada se perde num reinício, nada é
// entregue duas vezes) e digita no terminal do agente da sala: "📨 Demanda de <origem>: leia caixa-de-entrada/recebidas/<arquivo>...". Sala sem ninguém: o
// escritório retoma a última conversa dela (ou abre uma) e entrega quando o agente estiver pronto.
// Agente pedindo permissão (ou esperando você): a entrega espera, para não cair dentro de um menu do terminal.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentInfo, PtyInfo } from '../../shared/types';
import { errMsg, log } from '../log';

export const INBOX = 'caixa-de-entrada';
export const RECEIVED = 'recebidas';

export interface HandoffDeps {
  rooms: () => readonly string[];
  /** Agente principal vivo na sala (pasta), se houver. */
  agentOf: (roomPath: string) => AgentInfo | undefined;
  /** Terminal interativo do agente, se ele roda aqui. */
  ptyOf: (agentId: string) => PtyInfo | undefined;
  /** Abre a sessão da sala (retomando a última conversa, se houver). */
  open: (roomPath: string) => void;
  /** Digita no terminal. */
  type: (ptyId: string, data: string) => void;
  roomName: (path: string) => string;
  now?: () => number;
  intervalMs?: number;
}

interface Waiting {
  room: string;
  /** Nome do arquivo na caixa de entrada. */
  file: string;
  from: string;
  since: number;
  opened: boolean;
}

/** "De:" escrito na demanda (ex.: "**De:** Ofertas BR"); senão, quem escreveu fica sem nome. */
export function handoffOrigin(text: string): string {
  const m = /^\s*(?:\*\*)?de(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/im.exec(text.slice(0, 2000));
  return m ? m[1].replace(/\*/g, '').trim().slice(0, 40) : 'outra sala';
}

/** O que o escritório digita para o agente. */
export function handoffPrompt(from: string, rel: string): string {
  return `📨 Demanda nova de ${from}: leia ${rel} e faça o que ela pede, seguindo as regras desta sala. Quando terminar, mova o arquivo para ${INBOX}/feitas/.`;
}

export class HandoffWatcher {
  private queue: Waiting[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: HandoffDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.d.intervalMs ?? 4_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Uma passada: recolhe as demandas novas e entrega as que puder. Devolve as entregues (testes). */
  tick(): string[] {
    for (const room of this.d.rooms()) this.collect(room);
    const delivered: string[] = [];
    for (const w of [...this.queue]) {
      const agent = this.d.agentOf(w.room);
      const pty = agent ? this.d.ptyOf(agent.id) : undefined;
      if (!agent || !pty) {
        // Sem ninguém (ou com a sessão aberta fora do escritório, sem como digitar): abre a sala uma vez.
        if (!agent && !w.opened) {
          w.opened = true;
          try {
            this.d.open(w.room);
          } catch (err) {
            log.warn(`Bastão: não deu para abrir ${this.d.roomName(w.room)} (${errMsg(err)}).`);
          }
        }
        continue;
      }
      // Pedido de permissão ou pergunta na tela: espera para não digitar dentro do menu.
      if (agent.permission || agent.status === 'waiting') continue;
      // Sessão recém-aberta: dá um tempo para o Claude Code terminar de subir.
      if (this.now() - pty.startedAt < 5_000) continue;
      this.queue = this.queue.filter((x) => x !== w);
      let rel: string;
      try {
        rel = this.receive(w);
      } catch (err) {
        log.warnOnce(`handoff:${w.room}/${w.file}`, `Bastão: não deu para receber ${w.file} (${errMsg(err)}).`);
        continue;
      }
      this.d.type(pty.id, handoffPrompt(w.from, rel));
      setTimeout(() => this.d.type(pty.id, '\r'), 150).unref?.();
      delivered.push(join(w.room, rel));
      log.info(`Bastão: demanda de ${w.from} entregue em ${this.d.roomName(w.room)} (${rel}).`);
    }
    return delivered;
  }

  /** Demandas novas da sala: entram na fila (o arquivo continua na caixa até ser entregue). */
  private collect(room: string): void {
    const inbox = join(room, INBOX);
    let files: string[];
    try {
      files = readdirSync(inbox).filter((f) => /\.(md|txt)$/i.test(f) && !f.startsWith('.') && !f.startsWith('_'));
    } catch {
      return;
    }
    for (const f of files) {
      if (this.queue.some((w) => w.room === room && w.file === f)) continue;
      const src = join(inbox, f);
      try {
        // Arquivo ainda sendo escrito: espera ele parar de mudar.
        if (this.now() - statSync(src).mtimeMs < 1_500) continue;
        this.queue.push({ room, file: f, from: handoffOrigin(readFileSync(src, 'utf8')), since: this.now(), opened: false });
      } catch {
        /* sumiu no meio */
      }
    }
  }

  /** Move a demanda para recebidas/ e devolve o caminho relativo à sala. */
  private receive(w: Waiting): string {
    const dir = join(w.room, INBOX, RECEIVED);
    mkdirSync(dir, { recursive: true });
    let name = w.file;
    for (let i = 2; existsSync(join(dir, name)); i++) name = w.file.replace(/(\.\w+)$/, `-${i}$1`);
    renameSync(join(w.room, INBOX, w.file), join(dir, name));
    return `${INBOX}/${RECEIVED}/${basename(name)}`;
  }
}
