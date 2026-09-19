// node examples/typescript/connect.ts /absolute/path/host.sock TASK_ID
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

const [socketPath, taskId] = process.argv.slice(2);
if (!socketPath || !taskId)
  throw new Error('Usage: node examples/typescript/connect.ts SOCKET_PATH TASK_ID');
const client = await connectOrchestrator({ socketPath });
try {
  console.log(await client.tasks.get(taskId));
  console.log(await client.usage.get({ taskId }));
} finally {
  await client.close(); // Only disconnect this client; the shared host keeps running.
}
