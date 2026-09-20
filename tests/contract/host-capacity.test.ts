import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import type { Engine } from '../../packages/engine/src/types.ts';

test(
  'AC-F16 host-wide pending work and connection counts are bounded across clients',
  { timeout: 10000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-capacity-'))),
      socketPath = join(root, 'host.sock');
    let pending = 0;
    const sockets: Socket[] = [];
    const engine = {
      storeId: 'fixture',
      instanceId: 'fixture',
      async close() {
        return { status: 'closed', operationId: 'closed' };
      },
      async call(method: string, _params: any, context: any) {
        if (method === 'initialize') return { protocolVersion: '2.0' };
        if (method === 'echo') return 'ok';
        pending++;
        try {
          return await new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('disconnected')), {
              once: true,
            });
          });
        } finally {
          pending--;
        }
      },
    } as Engine;
    const host = await startUnixHost(engine, { socketPath });
    const open = async () => {
      const socket = createConnection(socketPath);
      sockets.push(socket);
      await once(socket, 'connect');
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      socket.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion: '2.0', sdkVersion: 'fixture' },
        }) + '\n',
      );
      await lines.next();
      return { socket, lines };
    };
    try {
      const clients = [];
      for (let i = 0; i < 5; i++) clients.push(await open());
      for (let i = 0; i < 4; i++)
        for (let id = 0; id < 64; id++)
          clients[i]!.socket.write(
            JSON.stringify({ jsonrpc: '2.0', id, method: 'hold', params: {} }) + '\n',
          );
      const deadline = performance.now() + 2000;
      while (pending < 256 && performance.now() < deadline)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(pending, 256);
      clients[4]!.socket.write(
        JSON.stringify({ jsonrpc: '2.0', id: 'excess', method: 'hold', params: {} }) + '\n',
      );
      const rejected = JSON.parse((await clients[4]!.lines.next()).value!);
      assert.equal(rejected.error.data.code, 'HOST_REQUEST_LIMIT_EXCEEDED');
      clients[0]!.socket.destroy();
      while (pending > 192) await new Promise((r) => setTimeout(r, 5));
      clients[4]!.socket.write(
        JSON.stringify({ jsonrpc: '2.0', id: 'echo', method: 'echo', params: {} }) + '\n',
      );
      assert.equal(JSON.parse((await clients[4]!.lines.next()).value!).result, 'ok');
      for (const socket of sockets) socket.destroy();
      while (pending) await new Promise((r) => setTimeout(r, 5));
      const idle: Socket[] = [];
      for (let i = 0; i < 32; i++) {
        const socket = createConnection(socketPath);
        idle.push(socket);
        sockets.push(socket);
        await once(socket, 'connect');
      }
      const excess = createConnection(socketPath);
      sockets.push(excess);
      await once(excess, 'close');
      assert.equal(excess.destroyed, true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
