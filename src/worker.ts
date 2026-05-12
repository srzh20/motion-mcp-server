import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MotionApiService } from "./services/motionApi";
import { WorkspaceResolver } from "./utils/workspaceResolver";
import { InputValidator } from "./utils/validator";
import { HandlerFactory } from "./handlers/HandlerFactory";
import { ToolRegistry, ToolConfigurator } from "./tools";
import { jsonSchemaToZodShape } from "./utils/jsonSchemaToZod";
import { SERVER_INSTRUCTIONS } from "./utils/serverInstructions";

interface Env {
  MOTION_API_KEY: string;
  MOTION_MCP_SECRET: string;
  MOTION_MCP_TOOLS?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

export class MotionMCPAgent extends McpAgent<Env> {
  server = new McpServer(
    { name: "motion-mcp-server", version: "2.8.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  async init() {
    const motionService = new MotionApiService(this.env.MOTION_API_KEY);
    const workspaceResolver = new WorkspaceResolver(motionService);
    const validator = new InputValidator();
    const context = { motionService, workspaceResolver, validator };
    const handlerFactory = new HandlerFactory(context);

    const registry = new ToolRegistry();
    const configurator = new ToolConfigurator(
      this.env.MOTION_MCP_TOOLS || "complete",
      registry
    );
    const enabledTools = configurator.getEnabledTools();
    validator.initializeValidators(enabledTools);

    for (const tool of enabledTools) {
      const zodShape = jsonSchemaToZodShape(tool.inputSchema as Parameters<typeof jsonSchemaToZodShape>[0]);

      this.server.tool(
        tool.name,
        tool.description,
        zodShape,
        async (params) => {
          const handler = handlerFactory.createHandler(tool.name);
          return await handler.handle(params);
        }
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", server: "motion-mcp-server" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate secret path: /mcp/{secret}/...
    // Clients configure URL as: https://your-worker.workers.dev/mcp/YOUR_SECRET
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts[0] !== "mcp" || pathParts[1] !== env.MOTION_MCP_SECRET) {
      return new Response("Not found", { status: 404 });
    }

    // Rewrite path to strip the secret before passing to McpAgent
    // e.g., /mcp/SECRET -> /mcp, /mcp/SECRET/sse -> /mcp/sse
    // Query string must be preserved so the SDK can read ?sessionId=... on POST.
    const cleanPath = "/mcp" + (pathParts.length > 2 ? "/" + pathParts.slice(2).join("/") : "");
    const cleanUrl = new URL(cleanPath + url.search, url.origin);
    const cleanRequest = new Request(cleanUrl, request);

    const response = await (
      MotionMCPAgent.mount("/mcp") as { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> }
    ).fetch(cleanRequest, env, ctx);

    // The agents SDK's legacy SSE handler emits `data: /mcp/message?sessionId=...`
    // based on its mount path. Clients POST that path verbatim, so the secret
    // must be reinjected or the auth check above rejects every follow-up message.
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") && response.body) {
      return new Response(
        injectSecretIntoSse(response.body, env.MOTION_MCP_SECRET),
        {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        }
      );
    }

    return response;
  },
};

function injectSecretIntoSse(
  body: ReadableStream<Uint8Array>,
  secret: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const replacement = `data: /mcp/${secret}/`;
  let pending = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (pending) controller.enqueue(encoder.encode(rewrite(pending, replacement)));
            controller.close();
            return;
          }
          pending += decoder.decode(value, { stream: true });
          const lastNl = pending.lastIndexOf("\n");
          if (lastNl >= 0) {
            const ready = pending.slice(0, lastNl + 1);
            pending = pending.slice(lastNl + 1);
            controller.enqueue(encoder.encode(rewrite(ready, replacement)));
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function rewrite(chunk: string, replacement: string): string {
  return chunk.replace(/^data:\s*\/mcp\//gm, replacement);
}
