/**
 * Spike: named-pipe local IPC on Bun/Windows — the channel through which the
 * per-session sidecar would receive hook fires. Path 1 uses Bun's native
 * unix-socket API against a Windows pipe path; path 2 uses node:net, which
 * maps pipe paths to named pipes on Node — does Bun do the same?
 */
const STAMP = Date.now().toString(36);
const PIPE_BUN = `\\\\.\\pipe\\slopwatch-spike-bun-${STAMP}`;
const PIPE_NET = `\\\\.\\pipe\\slopwatch-spike-net-${STAMP}`;

async function tryBunNative(): Promise<string> {
  try {
    const server = Bun.listen({
      unix: PIPE_BUN,
      socket: {
        data(s, data) {
          s.write(data);
          s.end();
        },
      },
    });
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("client timeout")), 3000);
      Bun.connect({
        unix: PIPE_BUN,
        socket: {
          open(s) {
            s.write("ping-over-bun");
          },
          data(s, data) {
            clearTimeout(timer);
            resolve(new TextDecoder().decode(data));
            s.end();
          },
          error(_s, err) {
            clearTimeout(timer);
            reject(err);
          },
        },
      }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    server.stop(true);
    return result;
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

async function tryNodeNet(): Promise<string> {
  const { createServer, connect } = await import("node:net");
  return new Promise<string>((resolve) => {
    const done = (v: string) => {
      server.close();
      resolve(v);
    };
    const server = createServer((socket) => {
      socket.pipe(socket);
    });
    server.on("error", (e) => resolve(`SERVER-ERROR: ${e.message}`));
    server.listen(PIPE_NET, () => {
      const client = connect(PIPE_NET);
      client.on("error", (e) => done(`CLIENT-ERROR: ${e.message}`));
      client.on("connect", () => client.write("ping-over-node-net"));
      client.on("data", (d) => {
        client.end();
        done(d.toString());
      });
    });
    setTimeout(() => done("TIMEOUT"), 3000);
  });
}

const a = await tryBunNative();
console.log(
  `SPIKE named-pipe bun-native: ${a === "ping-over-bun" ? "PASS" : "FAIL"} — echo=${JSON.stringify(a)}`,
);
const b = await tryNodeNet();
console.log(
  `SPIKE named-pipe node:net:  ${b === "ping-over-node-net" ? "PASS" : "FAIL"} — echo=${JSON.stringify(b)}`,
);
