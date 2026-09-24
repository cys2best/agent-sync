import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config";
import { spawn } from "node:child_process";

export async function isDaemonRunning(port?: number): Promise<boolean> {
  const targetPort = port || getConfig().port;
  try {
    const res = await fetch(`http://127.0.0.1:${targetPort}/health`, {
      signal: AbortSignal.timeout(400),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      return data.status === "ok";
    }
  } catch {}
  return false;
}

export async function ensureDaemonRunning(port?: number): Promise<string> {
  const targetPort = port || getConfig().port;
  if (await isDaemonRunning(targetPort)) {
    return `http://127.0.0.1:${targetPort}`;
  }

  const pidFile = join(getConfig().globalDbDir, `daemon-${targetPort}.pid`);

  // Spawn daemon detached
  const binPath = join(import.meta.dir, "../../bin/agent-mem.ts");
  const child = spawn("bun", ["run", binPath, "daemon", "--port", targetPort.toString()], {
    detached: true,
    stdio: "ignore",
  });

  if (child.pid) {
    try {
      mkdirSync(getConfig().globalDbDir, { recursive: true });
      writeFileSync(pidFile, child.pid.toString());
    } catch {}
  }
  child.unref();

  // Poll for up to 2 seconds
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    if (await isDaemonRunning(targetPort)) {
      return `http://127.0.0.1:${targetPort}`;
    }
  }

  return `http://127.0.0.1:${targetPort}`;
}

export async function stopDaemon(port?: number): Promise<boolean> {
  const targetPort = port || getConfig().port;
  const pidFile = join(getConfig().globalDbDir, `daemon-${targetPort}.pid`);
  const legacyPidFile = join(getConfig().globalDbDir, "daemon.pid");
  const running = await isDaemonRunning(targetPort);

  if (!running) {
    if (existsSync(pidFile)) {
      try {
        unlinkSync(pidFile);
      } catch {}
    }
    if (existsSync(legacyPidFile)) {
      try {
        unlinkSync(legacyPidFile);
      } catch {}
    }
    return false;
  }

  for (const file of [pidFile, legacyPidFile]) {
    if (existsSync(file)) {
      try {
        const pid = parseInt(readFileSync(file, "utf-8").trim(), 10);
        if (pid && !isNaN(pid)) {
          process.kill(pid, "SIGTERM");
          unlinkSync(file);
          return true;
        }
      } catch {}
    }
  }
  return false;
}
