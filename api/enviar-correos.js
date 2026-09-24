// api/enviar-correos.js
//
// Función serverless de Vercel que se dispara sola, una vez al día
// (ver vercel.json), y manda el próximo lote de hasta 100 correos
// (límite del plan free de Resend) a los inscriptos del foro que
// todavía no lo recibieron.
//
// Guarda el progreso en una tabla de Supabase (ver supabase.sql para
// crearla). Las funciones serverless no tienen disco propio entre
// ejecuciones, así que el estado tiene que vivir afuera.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service_role, NO la "anon" pública
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL; // ej: foro@mail.foronea.ar
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const SUBJECT = process.env.SUBJECT || 'Novedades del Foro';
const LIMITE_DIARIO = 100; // límite del plan free de Resend
const TABLA = 'foro_enviados';

function parsearCSV(texto) {
  const lineas = texto.trim().split(/\r?\n/);
  const encabezado = lineas[0].split(',').map((h) => h.trim().toLowerCase());
  const idxEmail = encabezado.findIndex((h) => h.includes('mail'));
  const idxNombre = encabezado.findIndex((h) => h.includes('nombre'));

  if (idxEmail === -1) {
    throw new Error('No encontré una columna con "mail" en el encabezado del CSV.');
  }

  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    if (!lineas[i].trim()) continue;
    const campos = lineas[i].split(',');
    const email = (campos[idxEmail] || '').trim();
    const nombre = idxNombre !== -1 ? (campos[idxNombre] || '').trim() : '';
    if (email && email.includes('@')) {
      filas.push({ email, nombre });
    }
  }
  return filas;
}

function fechaHoyArgentina() {
  // Fecha en formato YYYY-MM-DD, en horario de Argentina (UTC-3, sin DST)
  const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return ahora.toISOString().slice(0, 10);
}

async function enviarLote(lote, textoMensaje) {
  const payload = lote.map((persona) => ({
    from: FROM_EMAIL,
    to: [persona.email],
    subject: SUBJECT,
    text: textoMensaje.replace(/\{\{nombre\}\}/g, persona.nombre || ''),
  }));

  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detalle = await res.text();
    throw new Error(`Resend devolvió ${res.status}: ${detalle}`);
  }

  return res.json();
}

export default async function handler(req, res) {
  // Protección: solo Vercel Cron (con el secreto configurado) puede disparar esto.
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const hoy = fechaHoyArgentina();

    // ¿Ya corrió hoy? Miramos si hay algún envío registrado desde las 00:00 de hoy (hora Argentina).
    const { data: corridaHoy, error: errorCorrida } = await supabase
      .from(TABLA)
      .select('email')
      .gte('enviado_en', `${hoy}T00:00:00-03:00`)
      .limit(1);

    if (errorCorrida) throw new Error(`Error consultando Supabase: ${errorCorrida.message}`);

    if (corridaHoy && corridaHoy.length > 0) {
      return res.status(200).json({ ok: true, mensaje: 'Ya se corrió hoy, no se manda de nuevo.' });
    }

    const textoMensaje = process.env.MENSAJE_TEXTO;
    if (!textoMensaje) {
      throw new Error('Falta la variable de entorno MENSAJE_TEXTO con el texto del correo.');
    }

    const respuestaCSV = await fetch(SHEET_CSV_URL);
    if (!respuestaCSV.ok) {
      throw new Error(`No pude descargar el CSV (status ${respuestaCSV.status}).`);
    }
    const textoCSV = await respuestaCSV.text();
    const personas = parsearCSV(textoCSV);

    const { data: enviadosPrevios, error: errorEnviados } = await supabase
      .from(TABLA)
      .select('email');

    if (errorEnviados) throw new Error(`Error consultando Supabase: ${errorEnviados.message}`);

    const setEnviados = new Set((enviadosPrevios || []).map((r) => r.email));
    const pendientes = personas.filter((p) => !setEnviados.has(p.email));

    if (pendientes.length === 0) {
      return res.status(200).json({ ok: true, mensaje: 'No hay inscriptos pendientes.' });
    }

    const lote = pendientes.slice(0, LIMITE_DIARIO);
    await enviarLote(lote, textoMensaje);

    // Guardar progreso: insertar el lote en Supabase (upsert por si se reintenta)
    const { error: errorInsert } = await supabase
      .from(TABLA)
      .upsert(
        lote.map((p) => ({ email: p.email, enviado_en: new Date().toISOString() })),
        { onConflict: 'email' }
      );

    if (errorInsert) throw new Error(`Se mandó el correo pero falló al guardar en Supabase: ${errorInsert.message}`);

    return res.status(200).json({
      ok: true,
      enviados_hoy: lote.length,
      pendientes_restantes: pendientes.length - lote.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
