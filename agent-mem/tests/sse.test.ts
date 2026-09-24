import { describe, expect, it } from "bun:test";
import { SSEHub, getWebUiHtml } from "../src/daemon/sse";

describe("SSE Hub", () => {
  it("registers clients and tracks active connections", () => {
    const hub = new SSEHub();
    expect(hub.getClientCount()).toBe(0);

    const client1 = hub.addClient();
    expect(hub.getClientCount()).toBe(1);
    expect(client1.response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(client1.response.headers.get("Cache-Control")).toBe("no-cache");
    expect(client1.response.headers.get("Connection")).toBe("keep-alive");
    expect(client1.response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    hub.removeClient(client1.id);
    expect(hub.getClientCount()).toBe(0);
  });

  it("handles removeClient gracefully for non-existent IDs", () => {
    const hub = new SSEHub();
    expect(() => hub.removeClient("non-existent-id")).not.toThrow();
    expect(hub.getClientCount()).toBe(0);
  });

  it("broadcasts formatted SSE messages to multiple clients", async () => {
    const hub = new SSEHub();
    const client1 = hub.addClient();
    const client2 = hub.addClient();
    expect(hub.getClientCount()).toBe(2);

    const reader1 = client1.response.body?.getReader();
    const reader2 = client2.response.body?.getReader();
    expect(reader1).toBeDefined();
    expect(reader2).toBeDefined();

    hub.broadcast("test_event", { message: "hello memory", count: 42 });

    const readToMatch = async (reader: ReadableStreamDefaultReader<Uint8Array>, target: string) => {
      let fullText = "";
      while (!fullText.includes(target)) {
        const { value, done } = await reader.read();
        if (done) break;
        fullText += new TextDecoder().decode(value);
      }
      return fullText;
    };

    if (reader1 && reader2) {
      const text1 = await readToMatch(reader1, "test_event");
      const text2 = await readToMatch(reader2, "test_event");

      expect(text1).toContain("event: test_event");
      expect(text1).toContain('"message":"hello memory"');
      expect(text1).toContain('"count":42');

      expect(text2).toContain("event: test_event");
      expect(text2).toContain('"message":"hello memory"');
      expect(text2).toContain('"count":42');

      reader1.cancel();
      reader2.cancel();
    }
  });

  it("removes client when consumer stream is cancelled", async () => {
    const hub = new SSEHub();
    const client = hub.addClient();
    expect(hub.getClientCount()).toBe(1);

    const reader = client.response.body?.getReader();
    await reader?.cancel();

    // Stream cancellation triggers cancel() callback in ReadableStream
    // Allow microtask to process
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hub.getClientCount()).toBe(0);
  });

  it("exports getWebUiHtml returning viewer HTML content", () => {
    const html = getWebUiHtml();
    expect(typeof html).toBe("string");
    expect(html).toContain("agent-mem");
    expect(html).toContain("Live Activity Stream");
    expect(html).toContain("EventSource");
    expect(html).toContain("/api/stream");
  });
});
