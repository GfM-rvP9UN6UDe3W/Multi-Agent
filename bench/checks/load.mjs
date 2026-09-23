// Loads the agent's modules from the workspace under test; the checks never live inside it.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.env.BENCH_WORKSPACE;
if (!workspace) throw new Error('BENCH_WORKSPACE is not set');
export const load = (path) => import(pathToFileURL(join(workspace, path)).href);
