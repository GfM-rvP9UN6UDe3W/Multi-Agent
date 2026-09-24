type Message = Record<string, any>;

export interface McpConnection {
  request(method: string, params?: unknown): Promise<Message>;
  notify(method: string, params?: unknown): void;
  /** Every message the server sent, in order. */
  readonly sent: Message[];
  readonly closed: boolean;
  /** Calls the server instance's close(). */
  close(): Promise<void>;
}

/**
 * Drives an in-process MCP server as the Claude Agent SDK does (0.3.241 to 0.3.281): it passes a
 * transport to the config's instance.connect, then hands each client message to transport.onmessage
 * and waits for the answer with the same id through transport.send.
 */
export async function connectMcp(server: unknown): Promise<McpConnection> {
  const { instance } = server as {
    instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> };
  };
  const sent: Message[] = [];
  const waiting = new Map<unknown, (message: Message) => void>();
  let closed = false;
  const transport = {
    onmessage: undefined as ((message: Message) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    async start() {},
    async send(message: Message) {
      if (closed) throw new Error('Transport is closed');
      sent.push(message);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    },
    async close() {
      if (closed) return;
      closed = true;
      transport.onclose?.();
    },
  };
  await instance.connect(transport);
  let sequence = 0;
  const message = (method: string, params: unknown) => ({
    jsonrpc: '2.0',
    method,
    ...(params === undefined ? {} : { params }),
  });
  return {
    sent,
    get closed() {
      return closed;
    },
    request(method, params) {
      const id = ++sequence;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        transport.onmessage!({ id, ...message(method, params) });
      });
    },
    notify(method, params) {
      transport.onmessage!(message(method, params));
    },
    close: () => instance.close(),
  };
}
