import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd } from '../sources/watcher';
import { ConversationArchive, lastRoomSession, roomSessions } from './rooms';

function line(type: string, message: unknown, at: string) {
  return JSON.stringify({ type, uuid: Math.random().toString(36), sessionId: 's', cwd: '/x', timestamp: at, message });
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'arq-'));
  const dir = join(base, '.claude');
  const room = join(base, 'escritorio', 'ofertas-br');
  const pedidos = join(base, 'escritorio', 'pedidos');
  mkdirSync(room, { recursive: true });
  mkdirSync(pedidos, { recursive: true });
  writeFileSync(join(pedidos, 'CLAUDE.md'), '# Operação: Pedidos\n<!-- arquivo: nao -->\n');
  const write = (r: string, sid: string, ageMin: number) => {
    const p = join(dir, 'projects', encodeCwd(r));
    mkdirSync(p, { recursive: true });
    const f = join(p, `${sid}.jsonl`);
    writeFileSync(
      f,
      [
        line('user', { role: 'user', content: 'analisa a escova' }, '2026-11-15T12:00:00Z'),
        line('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }] }, '2026-11-15T12:00:01Z'),
        line('assistant', { role: 'assistant', content: [{ type: 'text', text: 'Nota 8,5.' }] }, '2026-11-15T12:00:05Z'),
      ].join('\n') + '\n',
    );
    const t = Date.now() / 1000 - ageMin * 60;
    utimesSync(f, t, t);
  };
  write(room, '11111111-1111-1111-1111-111111111111', 30);
  write(room, '22222222-2222-2222-2222-222222222222', 5);
  write(pedidos, '33333333-3333-3333-3333-333333333333', 1);
  return { dirs: [{ account: '.claude', dir }], room, pedidos };
}

describe('salas: conversas e arquivo', () => {
  it('acha a conversa mais recente da sala', () => {
    const f = fixture();
    expect(roomSessions(f.dirs, f.room).map((s) => s.sessionId.slice(0, 1))).toEqual(['2', '1']);
    expect(lastRoomSession(f.dirs, f.room)?.sessionId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('arquiva as conversas em markdown e pula a sala que pediu para ficar de fora', () => {
    const f = fixture();
    const a = new ConversationArchive({ rooms: () => [f.room, f.pedidos], dirs: () => f.dirs, roomName: () => 'Ofertas BR' });
    const written = a.tick();
    expect(written).toHaveLength(2);
    expect(written.every((w) => w.includes('ofertas-br'))).toBe(true);
    const md = readFileSync(written[0], 'utf8');
    expect(md).toContain('**Davi**');
    expect(md).toContain('analisa a escova');
    expect(md).toContain('Nota 8,5.');
    expect(md).toContain('⚙ 1 ação: Read(a.md)');
    expect(a.tick()).toEqual([]);
  });
});
