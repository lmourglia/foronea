// api/enviar-correos.js
//
// Función serverless de Vercel que se dispara sola, una vez al día
// (ver vercel.json), y manda el próximo lote de hasta 100 correos
// (límite del plan free de Resend) a los inscriptos del foro que
// todavía no recibieron LA CAMPAÑA ACTUAL (definida por CAMPANA).
//
// El texto del correo viene de MENSAJE_TEXTO (texto plano, con
// {{nombre}} como variable), configurado como variable de entorno en
// Vercel — no hay Template de Resend ni HTML involucrado.
//
// Soporta varias campañas separadas en el tiempo (preforo, encuesta,
// futuras invitaciones) sin que se pisen entre sí: cada una se
// registra por separado en Supabase.
//
// Para lanzar una campaña nueva: cambiás CAMPANA, SUBJECT y
// MENSAJE_TEXTO en las variables de entorno de Vercel (ver README) y
// hacés Redeploy. No hay que tocar código ni la tabla de Supabase.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service_role / sb_secret_..., NO la pública
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL; // ej: foro@mail.foronea.ar
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const SUBJECT = process.env.SUBJECT || 'Novedades del Foro';
const CAMPANA = process.env.CAMPANA || 'default'; // ej: "preforo", "encuesta", "invitacion-2027"
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
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const hoy = fechaHoyArgentina();

    const { data: corridaHoy, error: errorCorrida } = await supabase
      .from(TABLA)
      .select('email')
      .eq('campana', CAMPANA)
      .gte('enviado_en', `${hoy}T00:00:00-03:00`)
      .limit(1);

    if (errorCorrida) throw new Error(`Error consultando Supabase: ${errorCorrida.message}`);

    if (corridaHoy && corridaHoy.length > 0) {
      return res.status(200).json({ ok: true, campana: CAMPANA, mensaje: 'Ya se corrió hoy, no se manda de nuevo.' });
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
      .select('email')
      .eq('campana', CAMPANA);

    if (errorEnviados) throw new Error(`Error consultando Supabase: ${errorEnviados.message}`);

    const setEnviados = new Set((enviadosPrevios || []).map((r) => r.email));
    const pendientes = personas.filter((p) => !setEnviados.has(p.email));

    if (pendientes.length === 0) {
      return res.status(200).json({ ok: true, campana: CAMPANA, mensaje: 'No hay inscriptos pendientes para esta campaña.' });
    }

    const lote = pendientes.slice(0, LIMITE_DIARIO);
    await enviarLote(lote, textoMensaje);

    const { error: errorInsert } = await supabase
      .from(TABLA)
      .upsert(
        lote.map((p) => ({ email: p.email, campana: CAMPANA, enviado_en: new Date().toISOString() })),
        { onConflict: 'email,campana' }
      );

    if (errorInsert) throw new Error(`Se mandó el correo pero falló al guardar en Supabase: ${errorInsert.message}`);

    return res.status(200).json({
      ok: true,
      campana: CAMPANA,
      enviados_hoy: lote.length,
      pendientes_restantes: pendientes.length - lote.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
