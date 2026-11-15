// Fork (nuvem): terminal e chat pela porta remota com login, só com 'pty' em HABBLAUD_REMOTE_ALLOW.
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ptyRequestProblem } from './pty';
import { parseAllow, parseRemoteConfig } from './remote';

const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;
const HASH = 'scrypt:15:8:1:Om7QYEPSmsZ_GJGrMxJm0w:_UeLuhjcCRDs5wAImx-K67z0kpV2BMprs1uZd6cV0-A';

describe('nuvem', () => {
  it("'pty' só entra quando listado", () => {
    expect(parseAllow('permissions,messages,pty').has('pty')).toBe(true);
    expect(parseAllow(undefined).has('pty')).toBe(false);
  });
  it('HABBLAUD_REMOTE_BEHIND_HTTPS liga o cookie seguro', () => {
    const env = { HABBLAUD_REMOTE_USER: 'davi', HABBLAUD_REMOTE_PASSWORD_HASH: HASH, HABBLAUD_REMOTE_INSECURE_HTTP: '1', HABBLAUD_REMOTE_BEHIND_HTTPS: '1' };
    expect(parseRemoteConfig(env, false, () => false).config?.behindHttps).toBe(true);
    expect(parseRemoteConfig({ ...env, HABBLAUD_REMOTE_BEHIND_HTTPS: '' }, false, () => false).config?.behindHttps).toBe(false);
  });
  it('pela porta remota (já com login) o Host do domínio passa, mas a origem continua conferida', () => {
    const ok = req('127.0.0.1', { host: 'escritorio.sslip.io', origin: 'https://escritorio.sslip.io' });
    expect(ptyRequestProblem(ok)).not.toBeNull(); // porta local: Host precisa ser localhost
    expect(ptyRequestProblem(ok, true)).toBeNull();
    expect(ptyRequestProblem(req('127.0.0.1', { host: 'escritorio.sslip.io', origin: 'https://outro.site' }), true)).not.toBeNull();
    expect(ptyRequestProblem(req('127.0.0.1', { host: 'escritorio.sslip.io', 'sec-fetch-site': 'cross-site' }), true)).not.toBeNull();
  });
});
