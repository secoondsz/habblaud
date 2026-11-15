import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, PtyInfo } from '../../shared/types';
import { handoffOrigin, HandoffWatcher } from './handoff';

function setup(agent?: Partial<AgentInfo>) {
  const room = join(mkdtempSync(join(tmpdir(), 'bastao-')), 'criativos');
  mkdirSync(join(room, 'caixa-de-entrada'), { recursive: true });
  const f = join(room, 'caixa-de-entrada', 'escova.md');
  writeFileSync(f, '# Demanda\n**De:** Ofertas BR\nFazer 5 criativos.');
  const old = Date.now() / 1000 - 10;
  utimesSync(f, old, old);
  const typed: string[] = [];
  const opened: string[] = [];
  const pty: PtyInfo = { id: 'p1', pid: 1, cwd: room, account: '.claude', agentId: 'a1', startedAt: 0 };
  const w = new HandoffWatcher({
    rooms: () => [room],
    agentOf: () => (agent ? ({ id: 'a1', status: 'idle', ...agent } as AgentInfo) : undefined),
    ptyOf: () => pty,
    open: (p) => opened.push(p),
    type: (_id, d) => typed.push(d),
    roomName: () => 'Criativos',
  });
  return { room, w, typed, opened };
}

describe('bastão entre salas', () => {
  it('lê a origem', () => {
    expect(handoffOrigin('**De:** Ofertas BR\nx')).toBe('Ofertas BR');
    expect(handoffOrigin('nada')).toBe('outra sala');
  });

  it('entrega ao agente da sala e move para recebidas', () => {
    vi.useFakeTimers();
    const s = setup({});
    expect(s.w.tick()).toHaveLength(1);
    expect(s.typed[0]).toContain('📨 Demanda nova de Ofertas BR');
    expect(s.typed[0]).toContain('caixa-de-entrada/recebidas/escova.md');
    expect(existsSync(join(s.room, 'caixa-de-entrada', 'recebidas', 'escova.md'))).toBe(true);
    vi.advanceTimersByTime(200);
    expect(s.typed[1]).toBe('\r');
    expect(s.w.tick()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('sala vazia: abre a sala e não perde a demanda', () => {
    const s = setup(undefined);
    expect(s.w.tick()).toHaveLength(0);
    expect(s.opened).toEqual([s.room]);
    expect(existsSync(join(s.room, 'caixa-de-entrada', 'escova.md'))).toBe(true);
    s.w.tick();
    expect(s.opened).toHaveLength(1);
  });

  it('espera o agente responder um pedido de permissão', () => {
    const s = setup({ status: 'waiting' });
    expect(s.w.tick()).toHaveLength(0);
    expect(s.typed).toEqual([]);
  });
});
