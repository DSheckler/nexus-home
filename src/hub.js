// Conexión en vivo con las pantallas (tablet y móviles) mediante WebSocket.
// Cuando alguien añade algo a la lista o deja una nota, el servidor lo envía al momento
// a todas las pantallas conectadas, sin esperar a la siguiente actualización.
// Usa un Durable Object con "hibernación": mientras nadie escribe, no consume nada.

import { DurableObject } from "cloudflare:workers";

export class HomeHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Los "ping" de las pantallas se contestan solos, sin despertar al objeto
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Se esperaba WebSocket", { status: 426 });
    const scope = new URL(request.url).searchParams.get("scope") === "full" ? "full" : "family";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [scope]);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "nexus" } });
  }

  // Envía un mensaje a todas las pantallas. scope "full" = solo a la tablet.
  async broadcast(msg, scope) {
    const text = JSON.stringify(msg);
    for (const ws of scope ? this.ctx.getWebSockets(scope) : this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* conexión ya cerrada */ }
    }
  }

  async webSocketMessage() { /* las pantallas solo escuchan */ }
  async webSocketClose(ws, code) { try { ws.close(code, "adiós"); } catch { /* ya cerrada */ } }
  async webSocketError(ws) { try { ws.close(1011, "error"); } catch { /* ya cerrada */ } }
}

// Aviso a las pantallas (no bloquea la respuesta)
export function notify(env, ctx, msg, scope) {
  if (!env.HUB) return Promise.resolve();
  const p = env.HUB.get(env.HUB.idFromName("casa")).broadcast(msg, scope).catch((e) => console.error("hub", e));
  if (ctx) ctx.waitUntil(p);
  return p;
}
