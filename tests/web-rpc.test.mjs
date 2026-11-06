import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRpc } from "../apps/poc/src/lib/rpc-handler.mjs";
import {
  validateGateway,
  validateRpcRequest,
} from "../apps/poc/src/lib/rpc-policy.mjs";

const payload = (method = "eth_chainId", params = []) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});
const request = (body = payload(), headers = {}) =>
  new Request("http://localhost:3000/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const noFetch = () => {
  assert.fail("Rejected requests must not reach the gateway");
};

test("playground forwards allowed requests once to a fixed gateway", async () => {
  let calls = 0;
  const response = await handleRpc(request(), {
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, "https://undertaken-decide-gathered-epic.trycloudflare.com/rpc");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.deepEqual(JSON.parse(init.body), payload());
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x539" });
    },
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: 1,
    result: "0x539",
  });
});

test("Next loopback normalization accepts only the actual same-port browser host", async () => {
  const fetchImpl = async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x539" });
  const valid = request(payload(), { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" });
  assert.equal((await handleRpc(valid, { fetchImpl })).status, 200);
  for (const headers of [
    { origin: "http://127.0.0.1:4000", host: "127.0.0.1:4000" },
    { origin: "http://evil.test:3000", host: "evil.test:3000" },
    { origin: "http://127.0.0.1:3000", host: "evil.test:3000" },
  ]) assert.equal((await handleRpc(request(payload(), headers), { fetchImpl: noFetch })).status, 403);
});

test("playground rejects unsupported RPC, batches, malformed params and foreign chain sends", async () => {
  const address = `0x${"11".repeat(20)}`;
  const envelope = {
    chainId: "0x539",
    sender: address,
    frames: [{}],
    signatures: ["0x01"],
  };
  assert.equal(
    validateRpcRequest(payload("eth_sendFrameTransaction", [envelope])),
    true
  );
  for (const body of [
    payload("debug_traceTransaction"),
    payload("constructor"),
    [payload()],
    payload("eth_getBalance", [address, "earliest"]),
    payload("eth_getTransactionReceipt", ["0x123"]),
    payload("eth_sendFrameTransaction", [{ ...envelope, chainId: "0x1" }]),
    payload("eth_sendFrameTransaction", [{ ...envelope, frames: [] }]),
  ]) {
    assert.equal(
      (await handleRpc(request(body), { fetchImpl: noFetch })).status,
      400
    );
  }
});

test("playground accepts loopback gateways only", async () => {
  for (const url of [
    "http://localhost:14337/rpc",
    "http://127.0.0.1/rpc",
    "http://[::1]/rpc",
  ]) {
    assert.equal(validateGateway(url), true);
  }
  for (const gateway of [
    "https://example.com",
    "file:///tmp/key",
    "http://localhost.evil.test",
    "http://user:pass@localhost/rpc",
    "http://localhost/rpc?target=other",
  ]) {
    assert.equal(
      (await handleRpc(request(), { gateway, fetchImpl: noFetch })).status,
      503
    );
  }
});

test("playground rejects cross-origin, non-JSON and malformed bodies", async () => {
  for (const [req, status] of [
    [request(payload(), { origin: "https://example.com" }), 403],
    [request(payload(), { "content-type": "text/plain" }), 415],
    [request("{broken"), 400],
  ])
    assert.equal((await handleRpc(req, { fetchImpl: noFetch })).status, status);
});

test("playground enforces its body limit even without Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(32_768));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("http://localhost:3000/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  });
  assert.equal((await handleRpc(req, { fetchImpl: noFetch })).status, 413);
  assert.equal(cancelled, true);
});

test("playground rejects mismatched and incomplete upstream responses", async () => {
  for (const result of [
    null,
    { jsonrpc: "2.0", id: 2, result: "0x539" },
    { jsonrpc: "2.0", id: 1 },
  ]) {
    const response = await handleRpc(request(), {
      fetchImpl: async () => Response.json(result),
    });
    assert.equal(response.status, 502);
  }
});

test("playground redacts upstream errors and never retries failed submissions", async () => {
  let calls = 0;
  const response = await handleRpc(request(), {
    fetchImpl: async () => {
      calls++;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32500,
          message: "secret upstream detail",
          data: "private payload",
        },
      });
    },
  });
  const result = await response.json();
  assert.equal(calls, 1);
  assert.equal(result.error.code, -32500);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  const unavailable = await handleRpc(request(), {
    fetchImpl: async () => {
      throw new Error("sensitive transport error");
    },
  });
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /sensitive/);
});
