// Preload for a socket host child (SPEC-0023 S03). Once the host's socket accepts connections, its
// startup stalls for STALL_MS before it continues, as a slow file system can hold the host's
// chmod. The fixture announces that window on the error output, so a test can signal inside it.
import { writeSync } from 'node:fs';
import { Server } from 'node:net';

const STALL_MS = 300;
const listen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  const callback = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : undefined;
  return Reflect.apply(listen, this, [
    ...args,
    () => {
      writeSync(2, 'fixture: socket accepts connections\n');
      setTimeout(() => callback?.(), STALL_MS);
    },
  ]) as Server;
} as typeof Server.prototype.listen;
