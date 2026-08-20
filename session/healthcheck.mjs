import { connect } from "node:net";

const targets = [8443, 8444];

try {
  await Promise.all(targets.map((port) => probe(port)));
} catch (error) {
  process.stderr.write(`fireball-session healthcheck failed: ${error.message}\n`);
  process.exitCode = 1;
}

function probe(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => socket.destroy(new Error(`port ${port} timed out`)), 750);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
