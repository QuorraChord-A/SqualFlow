const net = require("node:net");

// Uncommon range far away from common developer ports (3000, 8000-8090, 5173...).
const PACKAGED_PORT_RANGE = { start: 38200, end: 38299 };

function probePort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function allocateServicePorts({
  count = 3,
  range = PACKAGED_PORT_RANGE,
  probe = probePort,
} = {}) {
  const ports = [];
  for (let port = range.start; port <= range.end && ports.length < count; port += 1) {
    if (await probe(port)) ports.push(port);
  }
  if (ports.length < count) {
    throw new Error(
      `No ${count} free ports available in ${range.start}-${range.end} for local services.`,
    );
  }
  return ports;
}

module.exports = {
  PACKAGED_PORT_RANGE,
  probePort,
  allocateServicePorts,
};
