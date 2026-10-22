import { describe, it, expect } from "vitest";
import { NodeExecutor } from "../node-executor";

describe("NodeExecutor", () => {
  it("should run code and return the result", async () => {
    const executor = new NodeExecutor();
    const result = await executor.execute("async () => 6 * 7", []);

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  it("should call provider tools under their namespace", async () => {
    const executor = new NodeExecutor();
    const result = await executor.execute(
      "async () => await codemode.add({ a: 10, b: 32 })",
      [{ name: "codemode", fns: { add: async ({ a, b }) => a + b } }]
    );

    expect(result.result).toBe(52);
  });

  it("should sanitize tool names that are not valid identifiers", async () => {
    const executor = new NodeExecutor();
    const result = await executor.execute(
      "async () => await codemode.get_user({ id: 7 })",
      [{ name: "codemode", fns: { "get-user": async ({ id }) => id } }]
    );

    expect(result.result).toBe(7);
  });

  it("should surface host errors as ExecuteResult.error", async () => {
    const executor = new NodeExecutor();
    const result = await executor.execute(
      "async () => await codemode.fail({})",
      [
        {
          name: "codemode",
          fns: {
            fail: async () => {
              throw new Error("upstream exploded");
            }
          }
        }
      ]
    );

    expect(result.result).toBeUndefined();
    expect(result.error).toBe("upstream exploded");
  });

  it("should capture logs without affecting the result", async () => {
    const executor = new NodeExecutor();
    const result = await executor.execute(
      "async () => { console.log('hello', 1); return 1; }",
      []
    );

    expect(result.result).toBe(1);
    expect(result.logs).toEqual(["hello 1"]);
  });

  it("should kill the sandbox on timeout", async () => {
    const executor = new NodeExecutor({ timeout: 300 });
    const result = await executor.execute(
      "async () => { while (true) { await sleep(50); } }",
      []
    );

    expect(result.result).toBeUndefined();
    expect(result.error).toBe("Execution timed out");
  });

  it("should reject reserved provider names", async () => {
    const executor = new NodeExecutor();
    const result = await executor.execute("async () => 1", [
      { name: "__logs", fns: {} }
    ]);

    expect(result.error).toBe('Provider name "__logs" is reserved');
  });

  it("should not expose require or process to sandboxed code", async () => {
    const executor = new NodeExecutor();
    const result = await executor.execute(
      "async () => [typeof require, typeof process]",
      []
    );

    expect(result.result).toEqual(["undefined", "undefined"]);
  });
});
