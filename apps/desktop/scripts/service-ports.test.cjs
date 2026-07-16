const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const { allocateServicePorts, probePort } = require("../service-ports");

test("allocates the first sequential free ports in the range", async () => {
  const busy = new Set([38200, 38202]);
  const ports = await allocateServicePorts({
    count: 3,
    range: { start: 38200, end: 38210 },
    probe: async (port) => !busy.has(port),
  });
  assert.deepEqual(ports, [38201, 38203, 38204]);
});

test("fails when the range cannot provide enough free ports", async () => {
  await assert.rejects(
    allocateServicePorts({
      count: 2,
      range: { start: 38200, end: 38201 },
      probe: async () => false,
    }),
    /No 2 free ports available in 38200-38201/,
  );
});

test("probePort reports an occupied port as not free", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const { port } = server.address();
  try {
    assert.equal(await probePort(port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probePort(port), true);
});
