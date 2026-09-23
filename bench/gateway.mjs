// SPEC-0021 E04: a loopback gateway that plays the model for `bench/run.mjs --gateway`. The real
// Claude Code binary runs every arm, with its tools, sandbox and the engine's writable profile; only
// the model's answers are scripted. Each request is answered in three turns: Read the files of its
// reference solution, Write them, then a short final answer. Synthetic credentials; no model is called.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** The files of a request's reference solution, relative to the workspace. */
async function solutionFiles(bench, id) {
  const root = join(bench, 'solutions', id);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return { path: relative(root, path), content: await readFile(path, 'utf8') };
      }),
  );
}

const texts = (message) =>
  typeof message.content === 'string'
    ? [message.content]
    : (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text);

/**
 * Starts the gateway. `finalDelayMs` holds a request's final answer back, so that a test can keep
 * one Claude process running while another finishes.
 */
export async function startGateway({ bench, requests, finalDelayMs = {} }) {
  const solutions = Object.fromEntries(
    await Promise.all(requests.map(async ({ id }) => [id, await solutionFiles(bench, id)])),
  );
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.method !== 'POST') return response.writeHead(404).end();
    if (request.url.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json');
      return response.end('{"input_tokens":100}');
    }
    if (!request.url.startsWith('/v1/messages')) return response.writeHead(404).end();
    const body = JSON.parse(raw);
    const messages = (body.messages ?? []).filter((message) =>
      ['user', 'assistant'].includes(message.role),
    );
    // The current request is the latest user message that carries one of the prompts.
    let at = -1;
    let current;
    for (let index = messages.length - 1; index >= 0 && !current; index--) {
      if (messages[index].role !== 'user') continue;
      current = requests.find(({ prompt }) =>
        texts(messages[index]).some((text) => text.includes(prompt)),
      );
      if (current) at = index;
    }
    const turn = current ? messages.slice(at + 1).filter((m) => m.role === 'assistant').length : 0;
    const directory = /Primary working directory: (.+?)(?:\\n|")/.exec(raw)?.[1];
    calls.push({ request: current?.id ?? null, turn });
    let blocks;
    if (!current || !directory || turn >= 2) {
      if (current && finalDelayMs[current.id])
        await new Promise((resolve) => setTimeout(resolve, finalDelayMs[current.id]));
      blocks = [{ type: 'text', text: current ? `Done: ${current.id}` : 'OK' }];
    } else {
      const workspace = JSON.parse(`"${directory}"`);
      blocks = solutions[current.id].map((file, index) => ({
        type: 'tool_use',
        id: `toolu_${calls.length}_${index}`,
        // Claude Code writes an existing file only after reading it; reading a new one just fails.
        name: turn === 0 ? 'Read' : 'Write',
        input:
          turn === 0
            ? { file_path: join(workspace, file.path) }
            : { file_path: join(workspace, file.path), content: file.content },
      }));
    }
    const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const message = {
      id: `msg_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: blocks,
      stop_reason: stop,
      stop_sequence: null,
      usage,
    };
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(message));
    }
    const send = (type, data) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send('message_start', { message: { ...message, content: [], stop_reason: null } });
    blocks.forEach((block, index) => {
      send('content_block_start', {
        index,
        content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
      });
      send('content_block_delta', {
        index,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text: block.text }
            : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      send('content_block_stop', { index });
    });
    send('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    send('message_stop', {});
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
