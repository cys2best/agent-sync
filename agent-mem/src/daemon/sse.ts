import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export class SSEHub {
  private clients: Map<string, ReadableStreamDefaultController<Uint8Array>> = new Map();

  addClient(): { id: string; response: Response } {
    const clientId = randomUUID();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.set(clientId, controller);
        // Send initial heartbeat
        const initial = new TextEncoder().encode(": connected\n\n");
        controller.enqueue(initial);
      },
      cancel: () => {
        this.clients.delete(clientId);
      },
    });

    const response = new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });

    return { id: clientId, response };
  }

  removeClient(id: string): void {
    const controller = this.clients.get(id);
    if (controller) {
      try {
        controller.close();
      } catch {}
      this.clients.delete(id);
    }
  }

  broadcast(eventType: string, data: any): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = new TextEncoder().encode(payload);

    for (const [id, controller] of this.clients.entries()) {
      try {
        controller.enqueue(encoded);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

export function getWebUiHtml(): string {
  const uiHtmlPath = join(import.meta.dir, "../ui/index.html");
  return readFileSync(uiHtmlPath, "utf-8");
}
