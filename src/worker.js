// Monitor de Seguridad · contador de ingresos (Cloudflare Workers + Durable Object con SQLite)
// Guarda un conteo por día y un identificador anónimo por navegador.
// No guarda nombres, correos ni direcciones IP.
import { DurableObject } from 'cloudflare:workers';

const ZONA = 'America/Bogota';
const ID_VALIDO = /^[A-Za-z0-9-]{8,64}$/;

const diaLocal = f => f.toLocaleDateString('en-CA', { timeZone: ZONA });      // AAAA-MM-DD
function restarDias(dia, n) {
  const d = new Date(dia + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export class Contador extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS dia (d TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS visitante (id TEXT PRIMARY KEY, primero TEXT NOT NULL, ultimo TEXT NOT NULL)');
  }

  registrar(idVisitante) {
    const hoy = diaLocal(new Date());
    this.sql.exec('INSERT INTO dia (d, n) VALUES (?, 1) ON CONFLICT(d) DO UPDATE SET n = n + 1', hoy);
    if (idVisitante && ID_VALIDO.test(idVisitante)) {
      this.sql.exec('INSERT INTO visitante (id, primero, ultimo) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ultimo = excluded.ultimo',
                    idVisitante, hoy, hoy);
    }
  }

  resumen() {
    const hoy = diaLocal(new Date());
    const desde7 = restarDias(hoy, 6), desde30 = restarDias(hoy, 29);
    const porDia = {};
    for (const r of this.sql.exec('SELECT d, n FROM dia')) porDia[r.d] = r.n;
    const v = this.sql.exec('SELECT COUNT(*) AS t, COALESCE(SUM(ultimo >= ?), 0) AS a FROM visitante', desde30).one();
    const suma = desde => Object.entries(porDia).filter(([d]) => d >= desde).reduce((s, [, n]) => s + n, 0);
    const dias = [];
    for (let i = 29; i >= 0; i--) { const d = restarDias(hoy, i); dias.push({ d, n: porDia[d] || 0 }); }
    const meses = {};
    for (const [d, n] of Object.entries(porDia)) meses[d.slice(0, 7)] = (meses[d.slice(0, 7)] || 0) + n;
    return {
      total: Object.values(porDia).reduce((s, n) => s + n, 0),
      hoy: porDia[hoy] || 0,
      ult7: suma(desde7),
      ult30: suma(desde30),
      visitantes: v.t,
      activos30: v.a,
      desde: Object.keys(porDia).sort()[0] || null,
      dias,
      meses: Object.entries(meses).sort().map(([m, n]) => ({ m, n }))
    };
  }
}

function iguales(a, b) {                       // comparación en tiempo constante
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) dif |= (x[i] || 0) ^ (y[i] || 0);
  return dif === 0;
}

const json = (datos, estado = 200) => new Response(JSON.stringify(datos), {
  status: estado,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/visitas') return env.ASSETS.fetch(request);

    const contador = env.CONTADOR.get(env.CONTADOR.idFromName('global'));

    if (request.method === 'POST') {
      let v = null;
      try { v = (await request.json()).v; } catch (e) {}
      await contador.registrar(typeof v === 'string' ? v : null);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    if (request.method === 'GET') {
      if (!env.CLAVE_CONTADOR) return json({ error: 'sin_clave', mensaje: 'Falta configurar el secreto CLAVE_CONTADOR' }, 503);
      const dada = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!dada || !iguales(dada, env.CLAVE_CONTADOR)) return json({ error: 'no_autorizado' }, 401);
      return json(await contador.resumen());
    }

    return new Response('Método no permitido', { status: 405, headers: { Allow: 'GET, POST' } });
  }
};
