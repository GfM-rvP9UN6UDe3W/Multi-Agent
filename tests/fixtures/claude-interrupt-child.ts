import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Offline stream-json peer. It never launches the native CLI or contacts a model.
const [mode = 'confirm', resume = '', audit = ''] = process.argv.slice(2);
const sessionId = resume || '11111111-1111-4111-8111-111111111111';
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const record = (value: unknown) => {
  if (audit) appendFileSync(audit, JSON.stringify(value) + '\n');
};
let started = false,
  prompts = 0;
function terminal(interrupted: boolean) {
  send({
    type: 'result',
    session_id: sessionId,
    subtype: interrupted ? 'error_during_execution' : 'success',
    is_error: interrupted,
    terminal_reason: interrupted ? 'aborted_tools' : 'completed',
    errors: interrupted ? ['offline interrupted'] : [],
    result: interrupted ? undefined : 'offline revised result',
    usage: { input_tokens: 5, output_tokens: 2 },
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
  });
}
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'user') {
    record({ kind: 'prompt', message: value, resume });
    if (++prompts > 1) throw new Error('A dispatch may submit only one prompt');
    send({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      tools: [],
      model: 'offline',
      mcp_servers: [],
      permissionMode: 'dontAsk',
      slash_commands: [],
      apiKeySource: 'none',
    });
    setTimeout(
      () => {
        started = true;
        send({
          type: 'stream_event',
          session_id: sessionId,
          parent_tool_use_id: null,
          user_message_uuid: value.uuid,
          event: {
            type: 'message_start',
            message: {
              id: 'offline',
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'offline',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        });
        if (JSON.stringify(value.message.content).includes('Finish after revision'))
          terminal(false);
      },
      mode === 'startup' ? 40 : 1,
    );
  } else if (value.type === 'control_request') {
    const subtype = value.request.subtype;
    record({ kind: 'control', subtype, started });
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: value.request_id,
        response:
          subtype === 'initialize'
            ? { commands: [], models: [], account: {} }
            : { still_queued: [] },
      },
    });
    if (subtype === 'interrupt' && mode !== 'no-terminal')
      setTimeout(() => terminal(true), mode === 'late' ? 120 : 5);
  }
});
reader.on('close', () => process.exit(0));
