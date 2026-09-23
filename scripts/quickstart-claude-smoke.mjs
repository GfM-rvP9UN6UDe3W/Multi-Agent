/**
 * SPEC-0021 E01: runs examples/typescript/quickstart-claude.ts with the real Claude Code binary against
 * a loopback gateway that answers with scripted text. Synthetic credentials; no model is called.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-quickstart-gateway-')));
await mkdir(join(home, '.claude'), { mode: 0o700 });
const answers = {
  topics: 'Release on Friday\nSlow login page on mobile\nA quickstart for the docs',
  urgent: 'Slow login page on mobile',
};
const requests = [];
const send = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
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
  const history = JSON.stringify(body.messages);
  requests.push(history);
  const text = history.includes('most urgent') ? answers.urgent : answers.topics;
  const message = {
    id: `msg_${requests.length}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
  if (!body.stream) {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify(message));
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send(response, 'message_start', { message: { ...message, content: [], stop_reason: null } });
  send(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  send(response, 'content_block_stop', { index: 0 });
  send(response, 'message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  send(response, 'message_stop', {});
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(root, 'examples/typescript/quickstart-claude.ts')],
    {
      cwd: root,
      timeout: 300_000,
      // A private home: no credentials, settings or history of the machine are used.
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: tmpdir(),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_BASE_URL: url,
        ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
      },
    },
  );
  assert.match(stdout, /^1\. completed, session /m);
  assert.match(stdout, /^2\. completed, session /m);
  assert.match(stdout, /reused the first agent's session: true/);
  assert.ok(stdout.includes(answers.urgent), stdout);
  // The follow-up ran in the same native conversation: its request carries the first answer.
  const followUp = requests.findLast((history) => history.includes('most urgent'));
  assert.ok(
    followUp?.includes('Release on Friday'),
    'the follow-up did not include the first answer',
  );
  console.log(
    JSON.stringify({ quickstart: 'claude', gatewayRequests: requests.length, modelCalls: 0 }),
  );
} finally {
  server.close();
  await rm(home, { recursive: true, force: true });
}
