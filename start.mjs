// Supervisor for the combined dashboard container: runs the Next.js server
// (internal, :3000) and the gateway (:8080) side by side. If either process
// exits, tear the other down and exit so Docker restarts the whole container.
import { spawn } from 'node:child_process';

const procs = [];
let shuttingDown = false;

function shutdown(who, code, signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[start] ${who} exited (code=${code ?? '-'} signal=${signal ?? '-'}); stopping`);
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(typeof code === 'number' ? code : 1);
}

function launch(name, args, { cwd, env } = {}) {
  const p = spawn('node', args, { stdio: 'inherit', cwd, env: { ...process.env, ...env } });
  p.on('exit', (code, signal) => shutdown(name, code, signal));
  procs.push(p);
}

// Next standalone server (bound to loopback — only the gateway talks to it).
// The bundle is rooted at /app/dashboard, so run its entry from there.
launch('dashboard', ['apps/dashboard/server.js'], {
  cwd: 'dashboard',
  env: { PORT: '3000', HOSTNAME: '127.0.0.1' },
});
// Gateway: serves the UI by proxying to localhost:3000 and routes /a/:id/* to agents.
launch('gateway', ['gateway/dist/server.js'], {});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown('signal', 0, sig));
