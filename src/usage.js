// Contador diario de "neuronas" de Workers AI (cuota gratuita: 10.000/día, se reinicia 00:00 UTC).
// Sirve para pasar a la voz de la tablet antes de agotar la cuota.

export const DAILY_FREE = 10000;
// La voz natural es lo que más gasta (≈60 % ayer); se corta antes para que el
// asistente (texto + comprensión) siga funcionando todo el día.
export const VOICE_LIMIT = 5000; // a partir de aquí, la voz natural se desactiva hasta mañana

const key = () => "usage:" + new Date().toISOString().slice(0, 10);

export async function getUsage(env) {
  return Number(await env.NEXUS_KV.get(key())) || 0;
}

export async function addUsage(env, neurons) {
  if (!neurons) return;
  const k = key();
  const current = Number(await env.NEXUS_KV.get(k)) || 0;
  await env.NEXUS_KV.put(k, String(Math.round(current + neurons)), { expirationTtl: 3 * 86400 });
}
