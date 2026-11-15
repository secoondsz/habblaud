// Fork: HABBLAUD_SALAS (model/room-filter.ts) deixa de fora as sessões abertas fora das pastas do escritório.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { makeRoomFilter } from '../model/room-filter';
import { tempDir } from '../test/fixtures';
import { ClaudeWatcher } from './watcher';

setQuiet(true);

describe('ClaudeWatcher com filtro de salas', () => {
  it('só mostra as sessões dentro das pastas do escritório', () => {
    const home = tempDir().dir;
    const dir = join(home, '.claude');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    const clock = Date.now();
    const now = () => clock;
    const accounts = new AccountsService({ dirs: [dir], home, env: {}, now, onChange: () => {} });
    const office = new Office({
      names: new NameStore(null),
      version: 'teste',
      startedAt: clock,
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: () => undefined,
      now,
    });
    const watcher = new ClaudeWatcher({
      accounts,
      office,
      inDocker: false,
      now,
      isAlive: () => true,
      watch: false,
      allowCwd: makeRoomFilter(['/home/davi/escritorio']),
    });
    const open = (pid: number, cwd: string) =>
      writeFileSync(
        join(dir, 'sessions', `${pid}.json`),
        JSON.stringify({ pid, sessionId: `s${pid}`, cwd, startedAt: clock - 60_000, kind: 'interactive', status: 'idle' }),
      );
    open(1, '/home/davi/escritorio/trafego-pago');
    open(2, '/home/davi/jarvis');
    open(3, '/home/davi/escritorio-velho');

    watcher.poll();
    office.tick();
    const snap = office.commit().snapshot;
    expect(snap.agents.map((a) => a.roomId)).toEqual(['/home/davi/escritorio/trafego-pago']);
    expect(snap.rooms.map((r) => r.id)).toEqual(['/home/davi/escritorio/trafego-pago']);
  });

  it('salas fixas: aparecem vazias, recebem a sessão da pasta e não somem quando ela fecha', () => {
    const home = tempDir().dir;
    const dir = join(home, '.claude');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    let clock = Date.now();
    const now = () => clock;
    const accounts = new AccountsService({ dirs: [dir], home, env: {}, now, onChange: () => {} });
    const pinned = ['/home/davi/escritorio/ofertas-br', '/home/davi/escritorio/trafego-pago'];
    const office = new Office({
      names: new NameStore(null),
      version: 'teste',
      startedAt: clock,
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: () => undefined,
      pinnedRooms: () => pinned,
      roomAlias: (p) => (p.toLowerCase().endsWith('ofertas-br') ? 'Ofertas BR' : undefined),
      now,
    });
    const alive = new Set<number>([7]);
    const watcher = new ClaudeWatcher({ accounts, office, inDocker: false, now, isAlive: (pid) => alive.has(pid), watch: false });
    const rooms = () => {
      office.tick();
      return office.commit().snapshot.rooms.map((r) => `${r.name}|${r.id}`);
    };

    // sem ninguém: as duas salas já estão no prédio
    expect(rooms()).toEqual(['Ofertas BR|/home/davi/escritorio/ofertas-br', 'trafego-pago|/home/davi/escritorio/trafego-pago']);

    // sessão aberta com outra grafia do caminho entra na sala fixa (sem criar outra)
    writeFileSync(
      join(dir, 'sessions', '7.json'),
      JSON.stringify({ pid: 7, sessionId: 's7', cwd: '/HOME/davi/escritorio/Ofertas-BR/', startedAt: clock - 1000, kind: 'interactive', status: 'idle' }),
    );
    watcher.poll();
    expect(rooms()).toHaveLength(2);
    const agent = office.commit().snapshot.agents[0];
    expect(agent.roomId).toBe('/home/davi/escritorio/ofertas-br');

    // a sessão fecha e o período de graça passa: a sala continua
    alive.delete(7);
    rmSync(join(dir, 'sessions', '7.json'));
    clock += 5_000;
    watcher.poll();
    clock += 120_000;
    watcher.poll();
    expect(office.commit().snapshot.agents.filter((a) => a.status !== 'offline' && a.status !== 'done').length).toBeLessThanOrEqual(1);
    clock += 600_000;
    office.tick();
    expect(rooms()).toHaveLength(2);
  });
});

