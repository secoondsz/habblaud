// Chat em balões (fork secoondsz): a sessão do Claude Code com cara de WhatsApp. À esquerda, as conversas (uma por
// sala); à direita, a conversa em balões. Não é uma cópia: é a MESMA sessão. A conversa vem do transcript dela
// (GET /api/agents/:id/terminal) e o que você manda é digitado no terminal dela (POST /api/pty/:id/input), como se
// você estivesse nele: comandos de barra, parar (Esc), trocar o modo (Shift+Tab), mensagem com o agente trabalhando
// (entra na fila dele). Sessão aberta noutro lugar (app do Claude): a mensagem vai pelo plugin de mensagens e aparece
// "Trazer para o escritório" (encerra lá e continua a mesma conversa aqui). Fotos: gravadas em <sala>/anexos/<dia>/
// (POST /api/chat/files) e citadas na mensagem. Sala vazia: escrever já abre a sessão e manda quando ela estiver
// pronta. A lógica pura está em ui/chat-model.ts.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxMessage, PermissionDecision, PtyInfo, RecentSession, RoomInfo, TerminalEntry } from '../../../shared/types';
import { access } from '../net/access';
import { createAvatar, createAvatarPlaceholder } from './avatar';
import {
  bubbleTime,
  chatItems,
  chatMessage,
  itemSignature,
  KEY_ENTER,
  KEY_ESC,
  KEY_SHIFT_TAB,
  modeFromScreen,
  modeLabel,
  opensMenu,
  pendingArrived,
  presence,
  preview,
  messageImages,
  ptyTyping,
  samePath,
  slashMatches,
  splitPhotos,
  splitTables,
  workText,
  type ChatItem,
} from './chat-model';
import { composerMode, enterSends, isSettled } from './composer-model';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setText } from './dom';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { maximizeButton, Movable } from './movable';
import { closePty, createPty, ptyInput, takeoverAgent } from './ptyapi';
import { parseAppend, parseInit, terminalUrl } from './terminal';

const MAX_PHOTOS = 6;
const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
/** Espera pela sessão nova antes de desistir da primeira mensagem. */
const START_TIMEOUT_MS = 60_000;

interface Pending {
  key: string;
  roomId: string;
  /** O que vai para o agente (com as linhas das fotos). */
  text: string;
  /** O que você digitou (o balão mostra só isso). */
  typed: string;
  previews: string[];
  at: number;
  status: 'sending' | 'waiting-session' | 'queued' | 'sent' | 'delivered' | 'failed';
  error?: string;
  /** Fotos ainda não gravadas (sala sem sessão: grava quando ela abrir). */
  files?: File[];
}

interface Draft {
  file: File;
  url: string;
}

export function photoUrl(roomId: string, rel: string): string {
  return `/api/chat/file?room=${encodeURIComponent(roomId)}&p=${encodeURIComponent(rel)}`;
}

/** Markdown da resposta, com as tabelas (o markdown do terminal não desenha tabela). */
export function chatMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const seg of splitTables(src)) {
    if (seg.kind === 'md') {
      frag.append(renderMarkdown(seg.text));
      continue;
    }
    const table = h('table');
    seg.rows.forEach((cells, i) => {
      const tr = h('tr');
      for (const c of cells) {
        const cell = h(i === 0 ? 'th' : 'td');
        cell.append(renderMarkdown(c));
        tr.append(cell);
      }
      table.append(tr);
    });
    frag.append(h('div', { class: 'ui-chat__table' }, table));
  }
  return frag;
}

function toBase64(file: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export class ChatPanel implements UiComponent {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  private open = false;
  private roomId: string | null = null;
  private agentId: string | null = null;
  private source: EventSource | null = null;
  private entries: TerminalEntry[] = [];
  private items: ChatItem[] = [];
  private rows = new Map<string, { sig: string; el: HTMLElement }>();
  private expanded = new Set<string>();
  private pending: Pending[] = [];
  private drafts: Draft[] = [];
  private textDrafts = new Map<string, string>();
  private previews = new Map<string, string>();
  /** Salas abrindo sessão (desde quando). */
  private starting = new Map<string, number>();
  private follow = true;
  private sending = false;
  private listSig = '';
  private historyOpen = false;
  /** Modo lido da tela do terminal (agente -> modo, quando foi lido). */
  private liveMode = new Map<string, { mode: string; at: number }>();
  private modeReading = false;
  /** Última tentativa de ler o modo de cada agente (no máximo uma a cada 20 s). */
  private modeTried = new Map<string, number>();
  private movable: Movable;

  private listEl: HTMLElement;
  private sideSub: HTMLElement;
  private headAvatar: HTMLElement;
  private headName: HTMLElement;
  private headStatus: HTMLElement;
  private menuBtn: HTMLButtonElement;
  private menu: HTMLElement;
  private banner: HTMLElement;
  private scroll: HTMLElement;
  private thread: HTMLElement;
  private historyEl: HTMLElement;
  private typing: HTMLElement;
  private permBox: HTMLElement;
  private empty: HTMLElement;
  private tray: HTMLElement;
  private slash: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private modeBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private fileInput: HTMLInputElement;

  constructor(private ctx: UiContext) {
    this.button = iconButton(ICONS.chat, 'Conversas (C)', () => this.toggle(), 'ui-btn-chat');

    this.listEl = h('div', { class: 'ui-chat__list', role: 'listbox', attrs: { 'aria-label': 'Conversas' } });
    this.sideSub = h('small', { class: 'ui-chat__side-sub' });
    // Celular: o chat é a tela principal; o prédio fica a um toque.
    const office = h('button', { class: 'ui-chat__side-office', type: 'button', text: 'Ver o escritório', on: { click: () => this.close() } });
    const side = h(
      'aside',
      { class: 'ui-chat__side' },
      h('div', { class: 'ui-chat__side-head' }, h('div', { class: 'ui-chat__side-title' }, h('strong', { text: 'Conversas' }), this.sideSub), office),
      this.listEl,
    );

    this.headAvatar = h('span', { class: 'ui-chat__head-avatar' });
    this.headName = h('strong', { class: 'ui-chat__head-name' });
    this.headStatus = h('span', { class: 'ui-chat__head-status' });
    this.menu = h('div', { class: 'ui-chat__menu', hidden: true, role: 'menu' });
    this.menuBtn = h('button', { class: 'ui-icon-btn ui-icon-btn--sm ui-chat__menu-btn', type: 'button', text: '⋮', title: 'Mais opções', on: { click: () => this.toggleMenu() } });
    const close = iconButton(ICONS.close, 'Fechar conversas (Esc)', () => this.close(), 'ui-icon-btn--sm');
    // Celular: uma tela por vez, como no WhatsApp (a lista ou a conversa); "‹" volta para a lista.
    const back = h('button', { class: 'ui-icon-btn ui-icon-btn--sm ui-chat__back', type: 'button', text: '‹', title: 'Voltar para as conversas', attrs: { 'aria-label': 'Voltar para as conversas' }, on: { click: () => this.el.classList.add('ui-chat--list') } });
    const bar = h(
      'div',
      { class: 'ui-chat__bar' },
      back,
      this.headAvatar,
      h('div', { class: 'ui-chat__who' }, this.headName, this.headStatus),
      h('div', { class: 'ui-chat__menu-wrap' }, this.menuBtn, this.menu),
      maximizeButton(() => this.movable),
      close,
    );
    this.banner = h('div', { class: 'ui-chat__banner', hidden: true });

    this.thread = h('div', { class: 'ui-chat__thread' });
    this.historyEl = h('div', { class: 'ui-chat__history', hidden: true });
    this.typing = h('div', { class: 'ui-chat__row ui-chat__row--agent', hidden: true }, h('div', { class: 'ui-chat__bubble ui-chat__bubble--typing' }, h('i'), h('i'), h('i')));
    this.permBox = h('div', { class: 'ui-chat__perm-wrap', hidden: true });
    this.empty = h('div', { class: 'ui-chat__empty', hidden: true }, h('p', { text: 'O agente desta sala está descansando. Escreva abaixo: ele volta de onde parou.' }));
    this.scroll = h('div', { class: 'ui-chat__scroll' }, this.historyEl, this.thread, this.permBox, this.typing, this.empty);
    this.scroll.addEventListener('scroll', () => {
      this.follow = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 60;
    });

    this.tray = h('div', { class: 'ui-chat__tray', hidden: true });
    this.slash = h('div', { class: 'ui-chat__slash', hidden: true, role: 'listbox' });
    this.fileInput = h('input', { type: 'file', class: 'ui-chat__file', attrs: { accept: 'image/*', multiple: true, hidden: true } });
    this.fileInput.addEventListener('change', () => {
      this.addFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    const clip = iconButton(ICONS.attach, 'Mandar foto (ou cole com Ctrl+V)', () => this.fileInput.click(), 'ui-chat__clip');
    this.box = h('textarea', { class: 'ui-chat__input', attrs: { rows: 1, maxlength: MESSAGE_MAX, placeholder: isPhone() ? 'Mensagem' : 'Mensagem  ( / para comandos )', enterkeyhint: 'send' } });
    this.box.addEventListener('input', () => {
      if (this.roomId) this.textDrafts.set(this.roomId, this.box.value);
      this.resize();
      this.syncSend();
      this.paintSlash();
    });
    this.box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (enterSends(e)) {
        e.preventDefault();
        void this.send();
      } else if (e.key === 'Escape') {
        if (!this.slash.hidden) this.slash.hidden = true;
        else if (this.canStop()) void this.stop();
        else this.close();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        void this.cycleMode();
      }
    });
    this.box.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });
    this.sendBtn = h('button', { class: 'ui-chat__send', type: 'button', title: 'Mandar (Enter)', attrs: { 'aria-label': 'Mandar' }, on: { click: () => void this.send() } });
    this.sendBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20.5 21 12 3 3.5l.01 6.6L15 12 3.01 13.9z" fill="currentColor"/></svg>';
    this.stopBtn = h('button', { class: 'ui-chat__send ui-chat__stop', type: 'button', title: 'Parar o agente (Esc)', hidden: true, on: { click: () => void this.stop() } });
    this.stopBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
    this.modeBtn = h('button', { class: 'ui-chat__mode', type: 'button', title: 'Trocar o modo de permissão (Shift+Tab)', on: { click: () => void this.cycleMode() } });
    this.hint = h('p', { class: 'ui-chat__hint', hidden: true });
    const composer = h(
      'div',
      { class: 'ui-chat__composer' },
      this.slash,
      this.tray,
      h('div', { class: 'ui-chat__compose-row' }, clip, this.box, this.stopBtn, this.sendBtn),
      h('div', { class: 'ui-chat__compose-foot' }, this.modeBtn, this.hint),
      this.fileInput,
    );

    const main = h('section', { class: 'ui-chat__main' }, bar, this.banner, this.scroll, composer);
    main.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        main.classList.add('is-drop');
      }
    });
    main.addEventListener('dragleave', () => main.classList.remove('is-drop'));
    main.addEventListener('drop', (e) => {
      main.classList.remove('is-drop');
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });

    this.el = h('div', { class: 'ui-chat', hidden: true, role: 'dialog', attrs: { 'aria-label': 'Conversas com os agentes' } }, side, main);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!this.menu.hidden) this.menu.hidden = true;
        else this.close();
      }
    });
    this.movable = new Movable(this.el, bar, { key: 'habblaud.chat.box', enabled: () => !this.ctx.isNarrow() });
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(agentId?: string): void {
    this.open = true;
    this.el.hidden = false;
    this.button.classList.add('is-on');
    const agent = agentId ? this.ctx.agent(agentId) : undefined;
    const main = agent?.kind === 'sub' ? this.ctx.agent(agent.parentId ?? '') : agent;
    const room = main?.roomId ?? this.roomId ?? this.rooms()[0]?.id ?? null;
    this.el.classList.toggle('ui-chat--list', !main && isPhone());
    this.listSig = '';
    if (room) this.selectRoom(room, true);
    this.render();
    if (!isPhone()) setTimeout(() => this.box.focus(), 50);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    this.menu.hidden = true;
    this.button.classList.remove('is-on');
    this.disconnect();
    this.agentId = null;
  }

  // ------------------------------------------------------------------ dados

  private rooms(): RoomInfo[] {
    return [...(this.ctx.store.snapshot?.rooms ?? [])].sort((a, b) => a.slot - b.slot);
  }

  private room(): RoomInfo | undefined {
    return this.rooms().find((r) => r.id === this.roomId);
  }

  private mainOf(roomId: string): AgentInfo | undefined {
    const list = (this.ctx.store.snapshot?.agents ?? []).filter((a) => a.kind === 'main' && a.roomId === roomId && a.status !== 'offline' && a.status !== 'done');
    // A sessão que roda aqui no escritório tem preferência (é ela que o chat controla).
    return list.sort((a, b) => Number(!!this.ptyOf(b.id)) - Number(!!this.ptyOf(a.id)) || (b.statusSince ?? 0) - (a.statusSince ?? 0))[0];
  }

  /** Terminal interativo (aqui no escritório) da sessão, se ela roda nele. */
  private ptyOf(agentId: string | undefined | null): PtyInfo | undefined {
    if (!agentId) return undefined;
    return this.ctx.store.snapshot?.ptys?.find((p) => p.agentId === agentId && p.exitedAt === undefined);
  }

  private get ptyEnabled(): boolean {
    return !!this.ctx.terminals?.interactiveEnabled;
  }

  private selectRoom(roomId: string, force = false): void {
    if (!force && roomId === this.roomId) return;
    if (this.roomId) this.textDrafts.set(this.roomId, this.box.value);
    this.roomId = roomId;
    this.box.value = this.textDrafts.get(roomId) ?? '';
    this.resize();
    this.clearDrafts();
    this.historyOpen = false;
    this.historyEl.hidden = true;
    this.menu.hidden = true;
    this.listSig = '';
    this.connect(this.mainOf(roomId)?.id ?? null, true);
    this.render();
  }

  private connect(agentId: string | null, force = false): void {
    if (!force && agentId === this.agentId) return;
    this.disconnect();
    this.agentId = agentId;
    this.entries = [];
    this.items = [];
    this.rows.clear();
    this.thread.replaceChildren();
    this.follow = true;
    this.paintThread();
    this.openStream(agentId);
  }

  /**
   * Abre o stream da conversa. Sessão recém-aberta ainda não tem o arquivo da conversa (o servidor responde 404 e o
   * navegador desiste): tenta de novo a cada 2 s enquanto a conversa aberta for a deste agente.
   */
  private openStream(agentId: string | null): void {
    if (!agentId || !this.ctx.store.snapshot?.meta.terminal || !access().terminal) return;
    const es = new EventSource(terminalUrl(agentId));
    this.source = es;
    es.addEventListener('init', (ev) => {
      if (this.source !== es) return;
      const init = parseInit((ev as MessageEvent).data);
      if (!init) return;
      this.entries = init.entries;
      this.rebuild();
    });
    es.addEventListener('append', (ev) => {
      if (this.source !== es) return;
      this.entries.push(...parseAppend((ev as MessageEvent).data));
      this.rebuild();
    });
    es.addEventListener('error', () => {
      if (this.source !== es || es.readyState !== 2) return;
      es.close();
      this.source = null;
      setTimeout(() => {
        if (this.open && this.agentId === agentId && !this.source) this.openStream(agentId);
      }, 2_000);
    });
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
  }

  private rebuild(): void {
    this.items = chatItems(this.entries);
    if (this.roomId) this.previews.set(this.roomId, preview(this.items));
    for (const p of [...this.pending]) {
      if (p.roomId === this.roomId && (p.status === 'sent' || p.status === 'queued' || p.status === 'delivered') && pendingArrived(p.text, p.at, this.items)) this.dropPending(p);
    }
    this.paintThread();
    this.listSig = '';
    this.ctx.invalidate();
  }

  private dropPending(p: Pending): void {
    for (const u of p.previews) URL.revokeObjectURL(u);
    this.pending = this.pending.filter((x) => x !== p);
  }

  // ------------------------------------------------------------------ desenho

  private paintThread(): void {
    const keep = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const it of this.items) {
      const sig = itemSignature(it) + (this.expanded.has(it.id) ? '|open' : '');
      let row = this.rows.get(it.id);
      if (!row || row.sig !== sig) {
        row = { sig, el: this.itemEl(it) };
        this.rows.set(it.id, row);
      }
      keep.add(it.id);
      nodes.push(row.el);
    }
    for (const id of [...this.rows.keys()]) if (!keep.has(id)) this.rows.delete(id);
    for (const p of this.pending) if (p.roomId === this.roomId) nodes.push(this.pendingEl(p));
    this.thread.replaceChildren(...nodes);
    this.stick();
  }

  private stick(): void {
    if (this.follow) requestAnimationFrame(() => (this.scroll.scrollTop = this.scroll.scrollHeight));
  }

  private photosEl(paths: readonly string[], urls?: readonly string[]): HTMLElement | null {
    if (!paths.length && !urls?.length) return null;
    const box = h('div', { class: 'ui-chat__photos' });
    const list = urls?.length ? urls : paths.map((p) => photoUrl(this.roomId ?? '', p));
    for (const src of list) {
      const img = h('img', { class: 'ui-chat__photo', attrs: { src, alt: 'foto', loading: 'lazy' } });
      img.addEventListener('click', () => window.open(src, '_blank', 'noopener'));
      // Arquivo que não existe (ou fora da sala): some, em vez de mostrar a imagem quebrada.
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    return box;
  }

  private itemEl(it: ChatItem): HTMLElement {
    const time = h('span', { class: 'ui-chat__time', text: bubbleTime(it.at) });
    if (it.type === 'me') {
      const bubble = h(
        'div',
        { class: 'ui-chat__bubble ui-chat__bubble--me' },
        this.photosEl(it.photos),
        it.text ? h('div', { class: 'ui-chat__text', text: it.text }) : null,
        h('div', { class: 'ui-chat__meta' }, time, h('span', { class: 'ui-chat__ticks is-read', text: '✓✓' })),
      );
      return h('div', { class: 'ui-chat__row ui-chat__row--me' }, bubble);
    }
    if (it.type === 'agent') {
      const text = h('div', { class: 'ui-chat__text ui-chat__md' });
      text.append(chatMarkdown(it.text));
      // Print ou foto que o agente cita na resposta (arquivo dentro da sala): aparece aqui mesmo.
      const pics = this.photosEl(messageImages(it.text, this.room()?.path ?? ''));
      return h('div', { class: 'ui-chat__row ui-chat__row--agent' }, h('div', { class: 'ui-chat__bubble ui-chat__bubble--agent' }, text, pics, h('div', { class: 'ui-chat__meta' }, time)));
    }
    if (it.type === 'work') {
      const open = this.expanded.has(it.id);
      const chip = h('button', {
        class: `ui-chat__work${open ? ' is-open' : ''}`,
        type: 'button',
        text: `⚙ ${workText(it)} ${open ? '▴' : '▾'}`,
        title: open ? 'Esconder o detalhe' : 'Ver o que ele fez',
        on: {
          click: () => {
            if (this.expanded.has(it.id)) this.expanded.delete(it.id);
            else this.expanded.add(it.id);
            this.follow = false;
            this.paintThread();
          },
        },
      });
      const wrap = h('div', { class: 'ui-chat__row ui-chat__row--center ui-chat__row--work' }, chip);
      if (open) {
        wrap.append(
          h(
            'div',
            { class: 'ui-chat__steps' },
            ...it.steps.map((st) =>
              h('div', { class: `ui-chat__step${st.error ? ' is-error' : ''}` }, h('code', { text: st.title }), st.result ? h('pre', { text: st.result }) : null),
            ),
          ),
        );
      }
      return wrap;
    }
    return h('div', { class: 'ui-chat__row ui-chat__row--center' }, h('span', { class: `ui-chat__note ui-chat__note--${it.level}`, text: it.text }));
  }

  private pendingEl(p: Pending): HTMLElement {
    const ticks = p.status === 'failed' ? '!' : p.status === 'sending' || p.status === 'waiting-session' || p.status === 'queued' ? '🕓' : p.status === 'sent' ? '✓' : '✓✓';
    const bubble = h(
      'div',
      { class: `ui-chat__bubble ui-chat__bubble--me${p.status === 'failed' ? ' is-failed' : ''}` },
      this.photosEl([], p.previews),
      p.typed ? h('div', { class: 'ui-chat__text', text: p.typed }) : null,
      h('div', { class: 'ui-chat__meta' }, p.status === 'waiting-session' ? h('span', { class: 'ui-chat__time', text: 'abrindo a conversa…' }) : null, h('span', { class: 'ui-chat__time', text: bubbleTime(p.at) }), h('span', { class: 'ui-chat__ticks', text: ticks })),
      p.error ? h('div', { class: 'ui-chat__err', text: p.error }) : null,
    );
    return h('div', { class: 'ui-chat__row ui-chat__row--me' }, bubble);
  }

  private paintList(): void {
    const rooms = this.rooms();
    const live = rooms.filter((r) => this.mainOf(r.id)).length;
    const busy = rooms.filter((r) => presence(this.mainOf(r.id)).tone === 'typing').length;
    setText(this.sideSub, `${rooms.length} ${rooms.length === 1 ? 'sala' : 'salas'} · ${live} ${live === 1 ? 'agente ligado' : 'agentes ligados'}${busy ? ` · ${busy} trabalhando` : ''}`);
    const sig = rooms
      .map((r) => {
        const a = this.mainOf(r.id);
        return `${r.id}|${r.name}|${a?.id}|${a?.status}|${a?.activity?.text}|${!!a?.permission}|${this.previews.get(r.id) ?? ''}|${r.id === this.roomId}`;
      })
      .join(';');
    if (sig === this.listSig) return;
    this.listSig = sig;
    this.listEl.replaceChildren(
      ...rooms.map((r) => {
        const a = this.mainOf(r.id);
        const pres = presence(a);
        const face = a ?? roomFace(r);
        const avatar = face ? createAvatar(face, 'md') : createAvatarPlaceholder('md');
        const who = a?.name ?? r.agent?.name;
        const sub = a ? (pres.tone === 'online' ? this.previews.get(r.id) || 'online' : pres.text) : 'descansando · toque para conversar';
        return h(
          'button',
          {
            class: `ui-chat__contact${r.id === this.roomId ? ' is-on' : ''} is-${a ? pres.tone : 'off'}`,
            type: 'button',
            role: 'option',
            attrs: { 'aria-selected': String(r.id === this.roomId) },
            on: {
              click: () => {
                this.el.classList.remove('ui-chat--list');
                this.selectRoom(r.id);
              },
            },
          },
          avatar,
          h(
            'span',
            { class: 'ui-chat__contact-txt' },
            h('span', { class: 'ui-chat__contact-top' }, h('strong', { text: who ?? r.name }), who ? h('em', { text: r.name }) : null),
            h('small', { text: sub }),
          ),
          a?.permission ? h('span', { class: 'ui-chat__badge', text: '!' }) : null,
        );
      }),
    );
  }

  private paintPermission(agent: AgentInfo | undefined): void {
    const perm = agent?.permission;
    const key = perm ? perm.id : '';
    if (this.permBox.dataset.key === key) return;
    this.permBox.dataset.key = key;
    this.permBox.hidden = !perm;
    if (!perm || !agent) return this.permBox.replaceChildren();
    const decide = async (d: PermissionDecision, btns: HTMLButtonElement[]) => {
      for (const b of btns) b.disabled = true;
      const err = await this.ctx.store.decidePermission(perm.id, d);
      this.modeTried.delete(agent.id);
      if (err) {
        for (const b of btns) b.disabled = false;
        this.ctx.announce(err);
      }
    };
    const card = h('div', { class: 'ui-chat__bubble ui-chat__bubble--agent ui-chat__perm' });
    if (perm.questions?.length) {
      const answers = new Map<number, number>();
      const btns: HTMLButtonElement[] = [];
      for (const q of perm.questions) {
        card.append(h('div', { class: 'ui-chat__text', text: q.question }));
        const opts = h('div', { class: 'ui-chat__opts' });
        for (const o of q.options) {
          const b = h('button', { class: 'ui-btn', type: 'button', text: o.label, title: o.description ?? '' });
          b.addEventListener('click', () => {
            answers.set(q.index, o.index);
            for (const x of opts.querySelectorAll('button')) x.classList.toggle('is-on', x === b);
            if (answers.size === perm.questions!.length)
              void decide({ behavior: 'answer', answers: [...answers].map(([question, opt]) => ({ question, options: [opt] })) }, btns);
          });
          btns.push(b);
          opts.append(b);
        }
        card.append(opts);
      }
    } else {
      card.append(h('div', { class: 'ui-chat__text' }, h('strong', { text: 'Posso fazer isso? ' }), document.createTextNode(perm.text)), h('code', { class: 'ui-chat__perm-cmd', text: perm.title }));
      if (perm.input) card.append(h('pre', { class: 'ui-chat__perm-cmd', text: perm.input.slice(0, 600) }));
      const yes = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Aprovar' });
      const always = perm.suggestions?.length ? h('button', { class: 'ui-btn', type: 'button', text: 'Aprovar sempre', title: perm.suggestions[0] ? 'Aprova e não pergunta mais isso nesta sala' : '' }) : null;
      const no = h('button', { class: 'ui-btn', type: 'button', text: 'Recusar' });
      const btns = [yes, no, ...(always ? [always] : [])];
      yes.addEventListener('click', () => void decide({ behavior: 'allow' }, btns));
      always?.addEventListener('click', () => void decide({ behavior: 'allow', suggestion: perm.suggestions![0].index }, btns));
      no.addEventListener('click', () => void decide({ behavior: 'deny', message: 'O Davi recusou pelo chat.' }, btns));
      card.append(h('div', { class: 'ui-chat__opts' }, yes, ...(always ? [always] : []), no));
    }
    this.permBox.replaceChildren(h('div', { class: 'ui-chat__row ui-chat__row--agent' }, card));
    this.stick();
  }

  private paintBanner(agent: AgentInfo | undefined): void {
    const external = !!agent && !this.ptyOf(agent.id) && this.ptyEnabled;
    const key = external ? agent!.id : '';
    if (this.banner.dataset.key === key) return;
    this.banner.dataset.key = key;
    this.banner.hidden = !external;
    if (!external) return this.banner.replaceChildren();
    const btn = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Trazer para o escritório' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setText(btn, 'Trazendo…');
      try {
        await takeoverAgent(agent!.id);
      } catch (err) {
        btn.disabled = false;
        setText(btn, 'Trazer para o escritório');
        this.ctx.announce(err instanceof Error ? err.message : 'não deu');
      }
    });
    this.banner.replaceChildren(
      h('span', { text: 'Esta conversa está aberta em outro lugar (app do Claude ou outro terminal). Dá para conversar, mas parar, trocar o modo e os comandos só funcionam com ela aqui.' }),
      btn,
    );
  }

  private paintSlash(): void {
    const list = slashMatches(this.box.value);
    this.slash.hidden = !list.length;
    this.slash.replaceChildren(
      ...list.map((c) =>
        h(
          'button',
          {
            class: 'ui-chat__slash-item',
            type: 'button',
            on: {
              click: () => {
                this.box.value = c.cmd;
                this.slash.hidden = true;
                this.syncSend();
                this.box.focus();
              },
            },
          },
          h('code', { text: c.cmd }),
          h('span', { text: c.text + (c.menu ? ' (abre o terminal)' : '') }),
        ),
      ),
    );
  }

  render(): void {
    if (!this.open) return;
    if (!this.roomId || !this.rooms().some((r) => r.id === this.roomId)) {
      const first = this.rooms()[0];
      if (first) this.selectRoom(first.id, true);
    }
    const room = this.room();
    const agent = this.roomId ? this.mainOf(this.roomId) : undefined;
    if ((agent?.id ?? null) !== this.agentId) this.connect(agent?.id ?? null);
    if (agent && this.ptyOf(agent.id)) this.flushWaiting(agent);
    const startedAt = this.starting.get(this.roomId ?? '');
    if (startedAt && (agent || Date.now() - startedAt > START_TIMEOUT_MS)) this.starting.delete(this.roomId ?? '');
    const starting = this.starting.has(this.roomId ?? '');

    this.paintList();
    const who = agent?.name ?? room?.agent?.name;
    setText(this.headName, room ? (who ? `${who} · ${room.name}` : room.name) : 'Conversas');
    const pres = presence(agent);
    setText(this.headStatus, agent ? pres.text : starting ? 'voltando…' : 'descansando');
    this.headStatus.className = `ui-chat__head-status is-${agent ? pres.tone : starting ? 'typing' : 'off'}`;
    const face = agent ?? (room ? roomFace(room) : undefined);
    const avKey = agent?.id ?? (face ? `sala:${room?.id}` : '');
    if (this.headAvatar.dataset.key !== avKey) {
      this.headAvatar.dataset.key = avKey;
      this.headAvatar.replaceChildren(face ? createAvatar(face, 'md') : createAvatarPlaceholder('md'));
    }
    const typing = (!!agent && pres.tone === 'typing' && !agent.permission) || starting;
    if (this.typing.hidden === typing) {
      this.typing.hidden = !typing;
      this.stick();
    }
    this.paintPermission(agent);
    this.paintBanner(agent);
    this.empty.hidden = !!agent || !room || starting || this.pending.some((p) => p.roomId === this.roomId);

    const pty = this.ptyOf(agent?.id);
    let ready: boolean;
    let hint = '';
    if (!agent) {
      ready = !!room && this.ptyEnabled;
      if (!this.ptyEnabled) hint = 'Para abrir conversas pelo chat, ligue o escritório pelo "Abrir Escritorio" (terminal interativo).';
    } else if (pty) {
      ready = !this.ctx.store.replaying;
    } else {
      const mode = composerMode(agent, { enabled: !!this.ctx.store.snapshot?.meta.messages, local: access().messages, replaying: this.ctx.store.replaying });
      ready = mode.kind === 'ready';
      if (mode.kind !== 'ready') hint = mode.text;
    }
    this.box.disabled = !ready;
    setText(this.hint, hint);
    this.hint.hidden = !hint;
    this.modeBtn.hidden = !pty;
    // Pedido de permissão (ou menu) aberto: Shift+Tab cairia dentro dele. O botão espera.
    const busy = !!agent?.permission || agent?.status === 'waiting';
    this.modeBtn.disabled = busy;
    this.modeBtn.title = busy ? 'Responda o pedido acima antes de trocar o modo' : 'Trocar o modo de permissão (Shift+Tab)';
    const live = agent ? this.liveMode.get(agent.id) : undefined;
    if (pty && agent && !busy && Date.now() - (this.modeTried.get(agent.id) ?? 0) > 20_000) {
      this.modeTried.set(agent.id, Date.now());
      void this.readMode(agent.id, pty.id);
    }
    setText(this.modeBtn, `⇆ ${modeLabel(live?.mode ?? agent?.permissionMode)}`);
    const stop = this.canStop();
    this.stopBtn.hidden = !stop;
    this.sendBtn.hidden = stop && !this.box.value.trim() && !this.drafts.length;
    this.syncSend();
  }

  // ------------------------------------------------------------------ menu e histórico

  private toggleMenu(): void {
    if (!this.menu.hidden) {
      this.menu.hidden = true;
      return;
    }
    const agent = this.roomId ? this.mainOf(this.roomId) : undefined;
    const pty = this.ptyOf(agent?.id);
    const item = (text: string, fn: () => void, disabled = false) =>
      h('button', { class: 'ui-chat__menu-item', type: 'button', text, attrs: { disabled }, on: { click: () => ((this.menu.hidden = true), fn()) } });
    this.menu.replaceChildren(
      item('Nova conversa (/clear)', () => void this.newConversation(), !agent && !this.ptyEnabled),
      item('Conversas anteriores', () => void this.showHistory(), !this.ptyEnabled),
      item('Ver o terminal', () => agent && this.ctx.terminals?.open(agent.id), !agent),
      item('Encerrar a sessão', () => void (pty && closePty(pty.id)), !pty),
    );
    this.menu.hidden = false;
  }

  private async newConversation(): Promise<void> {
    const agent = this.roomId ? this.mainOf(this.roomId) : undefined;
    const pty = this.ptyOf(agent?.id);
    if (pty) await this.type(pty.id, '/clear');
    else if (!agent) await this.startSession(true);
    else this.ctx.announce('Traga a conversa para o escritório primeiro.');
  }

  private async showHistory(): Promise<void> {
    const room = this.room();
    if (!room) return;
    if (this.historyOpen) {
      this.historyOpen = false;
      this.historyEl.hidden = true;
      return;
    }
    this.historyOpen = true;
    this.historyEl.hidden = false;
    this.historyEl.replaceChildren(h('p', { class: 'ui-chat__history-title', text: 'Carregando conversas anteriores…' }));
    let list: RecentSession[] = [];
    try {
      const res = (await (await fetch('/api/sessions/recent')).json()) as { sessions?: RecentSession[] };
      list = (res.sessions ?? []).filter((s) => samePath(s.project, room.path));
    } catch {
      /* sem conexão */
    }
    const current = this.mainOf(room.id)?.sessionId;
    const rows = list
      .filter((s) => s.sessionId !== current)
      .slice(0, 15)
      .map((s) => {
        const when = new Date(s.lastAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        return h(
          'button',
          { class: 'ui-chat__history-item', type: 'button', on: { click: () => void this.resume(s) } },
          h('strong', { text: splitPhotos(s.title ?? '').text.replace(/\s+/g, ' ') || (s.title ? '📷 Foto' : 'Conversa sem título') }),
          h('small', { text: when }),
        );
      });
    this.historyEl.replaceChildren(
      h('p', { class: 'ui-chat__history-title', text: rows.length ? 'Conversas anteriores desta sala (toque para retomar)' : 'Nenhuma conversa anterior nos últimos dias.' }),
      ...rows,
    );
  }

  private async resume(s: RecentSession): Promise<void> {
    const room = this.room();
    if (!room) return;
    const agent = this.mainOf(room.id);
    if (agent && !this.ptyOf(agent.id)) return this.ctx.announce('Feche a conversa que está aberta no app primeiro.');
    this.historyOpen = false;
    this.historyEl.hidden = true;
    this.starting.set(room.id, Date.now());
    this.render();
    try {
      const pty = this.ptyOf(agent?.id);
      if (pty) {
        await closePty(pty.id);
        await sleep(800);
      }
      await createPty(room.path, s.account, s.sessionId);
    } catch (err) {
      this.starting.delete(room.id);
      this.ctx.announce(err instanceof Error ? err.message : 'não deu para retomar');
    }
    this.render();
  }

  // ------------------------------------------------------------------ teclas da sessão

  private canStop(): boolean {
    const agent = this.roomId ? this.mainOf(this.roomId) : undefined;
    return !!agent && !!this.ptyOf(agent.id) && (agent.status === 'working' || agent.status === 'shell');
  }

  private async stop(): Promise<void> {
    const pty = this.ptyOf(this.agentId);
    if (pty) await ptyInput(pty.id, KEY_ESC).catch(() => undefined);
  }

  private async cycleMode(): Promise<void> {
    const pty = this.ptyOf(this.agentId);
    if (!pty || !this.agentId || this.modeBtn.disabled) return;
    await ptyInput(pty.id, KEY_SHIFT_TAB).catch(() => undefined);
    setText(this.modeBtn, '⇆ trocando…');
    await sleep(500);
    await this.readMode(this.agentId, pty.id, true);
  }

  /** Lê o modo no rodapé da tela do terminal (o transcript só registra a troca na próxima mensagem). */
  private readMode(agentId: string, ptyId: string, force = false): Promise<void> {
    if (this.modeReading && !force) return Promise.resolve();
    this.modeReading = true;
    return new Promise((done) => {
      let es: EventSource;
      const finish = () => {
        es?.close();
        this.modeReading = false;
        this.render();
        done();
      };
      try {
        es = new EventSource(`/api/pty/${encodeURIComponent(ptyId)}/stream`);
      } catch {
        return finish();
      }
      const timer = setTimeout(finish, 3_000);
      es.addEventListener('reset', (ev) => {
        clearTimeout(timer);
        let screen = '';
        try {
          const v = JSON.parse((ev as MessageEvent).data) as unknown;
          screen = typeof v === 'string' ? v : String((v as { data?: string })?.data ?? '');
        } catch {
          /* tela ilegível */
        }
        const mode = modeFromScreen(screen);
        if (mode) this.liveMode.set(agentId, { mode, at: Date.now() });
        finish();
      });
      es.addEventListener('error', () => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  /** Digita o texto e aperta Enter no terminal da sessão. */
  private async type(ptyId: string, text: string): Promise<void> {
    await ptyInput(ptyId, ptyTyping(text));
    await sleep(120);
    await ptyInput(ptyId, KEY_ENTER);
  }

  /** Abre o agente da sala: retoma a última conversa dela (ou, com `fresh`, começa uma do zero). */
  private async startSession(fresh = false): Promise<void> {
    const room = this.room();
    if (!room || this.starting.has(room.id)) return;
    this.starting.set(room.id, Date.now());
    this.render();
    try {
      let last: { account?: string; sessionId?: string } = {};
      if (!fresh) last = (await (await fetch(`/api/chat/last?room=${encodeURIComponent(room.id)}`)).json().catch(() => ({}))) as typeof last;
      if (!(await createPty(room.path, last.account, last.sessionId, fresh))) throw new Error();
    } catch {
      this.starting.delete(room.id);
      this.ctx.announce('Não deu para abrir a conversa nesta sala.');
    }
    this.render();
  }

  // ------------------------------------------------------------------ fotos

  private addFiles(files: File[]): void {
    for (const file of files) {
      if (this.drafts.length >= MAX_PHOTOS) break;
      if (!file.type.startsWith('image/') || file.size > PHOTO_MAX_BYTES) continue;
      this.drafts.push({ file, url: URL.createObjectURL(file) });
    }
    this.paintTray();
    this.syncSend();
    this.box.focus();
  }

  private clearDrafts(): void {
    for (const d of this.drafts) URL.revokeObjectURL(d.url);
    this.drafts = [];
    this.paintTray();
  }

  private paintTray(): void {
    this.tray.hidden = !this.drafts.length;
    this.tray.replaceChildren(
      ...this.drafts.map((d) => {
        const x = h('button', { class: 'ui-chat__tray-x', type: 'button', text: '×', title: 'Tirar', on: { click: () => this.removeDraft(d) } });
        return h('div', { class: 'ui-chat__tray-item' }, h('img', { attrs: { src: d.url, alt: d.file.name } }), x);
      }),
    );
  }

  private removeDraft(d: Draft): void {
    URL.revokeObjectURL(d.url);
    this.drafts = this.drafts.filter((x) => x !== d);
    this.paintTray();
    this.syncSend();
  }

  private syncSend(): void {
    this.sendBtn.disabled = this.box.disabled || this.sending || (!this.box.value.trim() && !this.drafts.length);
  }

  private resize(): void {
    this.box.style.height = 'auto';
    this.box.style.height = `${Math.min(this.box.scrollHeight, 140)}px`;
  }

  private async uploadPhotos(agentId: string, files: File[]): Promise<string[]> {
    const paths: string[] = [];
    for (const f of files) {
      const res = await fetch('/api/chat/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, name: f.name || 'foto.png', type: f.type, data: await toBase64(f) }),
      });
      const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!res.ok || !body.path) throw new Error(body.error || 'não deu para mandar a foto');
      paths.push(body.path);
    }
    return paths;
  }

  // ------------------------------------------------------------------ envio

  private async send(): Promise<void> {
    const roomId = this.roomId;
    if (!roomId || this.sendBtn.disabled) return;
    const typed = this.box.value.trim();
    const drafts = this.drafts;
    this.drafts = [];
    this.paintTray();
    this.box.value = '';
    this.slash.hidden = true;
    this.textDrafts.delete(roomId);
    this.resize();
    const p: Pending = { key: Math.random().toString(36).slice(2), roomId, text: typed, typed, previews: drafts.map((d) => d.url), at: Date.now(), status: 'sending', files: drafts.map((d) => d.file) };
    const agent = this.mainOf(roomId);
    if (!agent) {
      // Sala vazia: abre a sessão e manda quando ela estiver pronta (flushWaiting).
      p.status = 'waiting-session';
      this.pending.push(p);
      this.follow = true;
      this.paintThread();
      await this.startSession();
      return;
    }
    this.pending.push(p);
    this.follow = true;
    this.paintThread();
    await this.deliver(p, agent);
  }

  /** Sessão aberta: manda as mensagens que esperavam por ela. */
  private flushWaiting(agent: AgentInfo): void {
    for (const p of this.pending) {
      if (p.roomId === agent.roomId && p.status === 'waiting-session') {
        p.status = 'sending';
        // Dá um tempo para o Claude Code terminar de abrir antes de digitar.
        void sleep(2500).then(() => this.deliver(p, agent));
      }
    }
  }

  private async deliver(p: Pending, agent: AgentInfo): Promise<void> {
    this.sending = true;
    this.syncSend();
    try {
      const photos = p.files?.length ? await this.uploadPhotos(agent.id, p.files) : [];
      p.files = undefined;
      p.text = chatMessage(p.typed, photos);
      const pty = this.ptyOf(agent.id);
      if (pty) {
        await this.type(pty.id, p.text);
        p.status = 'sent';
        if (opensMenu(p.text)) {
          this.dropPending(p);
          this.ctx.terminals?.open(agent.id);
        } else if (/^\/\w/.test(p.text)) this.dropPending(p);
      } else {
        const r = await this.ctx.store.sendMessage(agent.id, p.text);
        if ('error' in r) throw new Error(r.error);
        this.track(p, r.message);
      }
    } catch (err) {
      p.status = 'failed';
      p.error = err instanceof Error ? err.message : 'sem conexão';
    } finally {
      this.sending = false;
      if (p.status === 'sent' && pendingArrived(p.text, p.at, this.items)) this.dropPending(p);
      this.paintThread();
      this.syncSend();
    }
  }

  private track(p: Pending, m: OutboxMessage): void {
    p.status = m.status;
    p.error = m.error;
    if (pendingArrived(p.text, p.at, this.items)) return this.dropPending(p);
    if (isSettled(m.status)) return;
    setTimeout(async () => {
      if (!this.pending.includes(p)) return;
      try {
        const next = await this.ctx.store.messageStatus(m.id);
        if (next) this.track(p, next);
      } catch {
        this.track(p, m);
      }
      this.paintThread();
    }, 1500);
  }
}

/** Aviso do backup no topo: "☁ salvo há 3 min" (GET /api/backup). */
export class BackupChip {
  readonly el: HTMLElement;
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    this.el = h('span', { class: 'ui-backup', hidden: true });
    // Primeira consulta um pouco depois de abrir (a página carrega o resto antes).
    setTimeout(() => void this.poll(), 2_000);
    this.timer = setInterval(() => void this.poll(), 30_000);
  }

  private async poll(): Promise<void> {
    let st: { state?: string; lastPushAt?: number; error?: string; repo?: string } = {};
    try {
      st = (await (await fetch('/api/backup')).json()) as typeof st;
    } catch {
      return;
    }
    this.el.hidden = !st.state || st.state === 'off';
    if (this.el.hidden) return;
    const mins = st.lastPushAt ? Math.round((Date.now() - st.lastPushAt) / 60_000) : -1;
    const when = mins < 0 ? '' : mins < 1 ? 'agora' : mins < 60 ? `há ${mins} min` : `há ${Math.round(mins / 60)} h`;
    const text = st.state === 'error' ? '☁ backup com problema' : st.state === 'ok' && when ? `☁ salvo ${when}` : '☁ salvando…';
    setText(this.el, text);
    this.el.className = `ui-backup is-${st.state}`;
    this.el.title = st.state === 'error' ? `Backup no GitHub: ${st.error ?? 'erro'}` : `Tudo do escritório vai para ${st.repo ?? 'o GitHub'} a cada 3 minutos`;
  }
}

/** Celular (tela estreita): o chat vira a tela inteira, uma tela por vez. */
export function isPhone(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
}

/** Rosto do agente fixo da sala (mesmo descansando). */
function roomFace(room: RoomInfo): { seed: number; look: 'f' | 'm'; kind: 'main'; parts?: AgentInfo['parts'] } | undefined {
  const a = room.agent;
  return a ? { seed: a.seed, look: a.look, kind: 'main', ...(a.parts ? { parts: a.parts } : {}) } : undefined;
}
