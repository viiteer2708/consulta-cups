// ============================================================
// POST /api/acceso — canjea la clave por la cookie de sesión
// (espejo de mega-calculadora/src/app/api/acceso/route.ts)
// ============================================================
//
// Respuestas:
//   503 — `ACCESS_PASSWORD` no configurada en el servidor (la app queda cerrada).
//   429 — demasiados intentos fallidos desde esa IP (freno anti fuerza bruta).
//   401 — clave incorrecta.
//   204 — clave correcta; va con `Set-Cookie` del token firmado.
//
// Esta es la ÚNICA función de `api/` que no exige cookie: si no, nadie podría
// llegar nunca a autenticarse.
// ============================================================

const {
    sha256,
    igualesEnTiempoConstante,
    crearToken,
    cabeceraSetCookie,
} = require('./_auth.js');

// ------------------------------------------------------------
// Freno anti fuerza bruta
//
// Contador en la memoria del MÓDULO, por IP. En serverless cada instancia
// lleva el suyo y las instancias van y vienen, así que esto es *best-effort*:
// no es un límite exacto, es un freno que convierte el "probar claves a
// mansalva" en algo lento y caro.
// ------------------------------------------------------------

/** Fallos seguidos que activan el bloqueo. */
const MAX_FALLOS = 5;

/** Cuánto dura el bloqueo (y la ventana en la que se acumulan los fallos). */
const VENTANA_MS = 15 * 60 * 1000;

/** Retardo fijo en cada intento fallido: encarece el barrido de claves. */
const RETARDO_FALLO_MS = 400;

const intentos = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Primera IP de la cadena de proxies; sin cabecera, un cajón común. */
function ipDe(req) {
    const cabecera = req.headers['x-forwarded-for'];
    const texto = Array.isArray(cabecera) ? cabecera[0] : cabecera;
    return (texto && texto.split(',')[0].trim()) || 'desconocida';
}

/** Barre lo caducado en cada visita para que la Map no crezca sin límite. */
function limpiar(ahora) {
    for (const [ip, dato] of intentos) {
        if (dato.hasta <= ahora) intentos.delete(ip);
    }
}

function estaBloqueada(ip, ahora) {
    const dato = intentos.get(ip);
    return dato !== undefined && dato.fallos >= MAX_FALLOS && dato.hasta > ahora;
}

function anotarFallo(ip, ahora) {
    const previo = intentos.get(ip);
    const fallos = previo && previo.hasta > ahora ? previo.fallos + 1 : 1;
    intentos.set(ip, { fallos, hasta: ahora + VENTANA_MS });
}

/** El cuerpo puede llegar ya parseado por Vercel, como texto o ilegible. */
function claveDelCuerpo(body) {
    let cuerpo = body;
    if (typeof cuerpo === 'string') {
        try {
            cuerpo = JSON.parse(cuerpo);
        } catch {
            return '';
        }
    }
    if (cuerpo && typeof cuerpo === 'object' && typeof cuerpo.password === 'string') {
        return cuerpo.password;
    }
    return '';
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'method not allowed' });
    }

    const ahora = Date.now();
    const ip = ipDe(req);
    limpiar(ahora);

    if (estaBloqueada(ip, ahora)) {
        const segundos = Math.ceil((intentos.get(ip).hasta - ahora) / 1000);
        res.setHeader('Retry-After', String(segundos));
        return res
            .status(429)
            .json({ error: 'Demasiados intentos fallidos. Prueba de nuevo dentro de un rato.' });
    }

    const secreto = (process.env.ACCESS_PASSWORD || '').trim();

    if (!secreto) {
        return res.status(503).json({
            error:
                'La herramienta no tiene clave configurada en el servidor (ACCESS_PASSWORD). Avisa a dirección.',
        });
    }

    // Un cuerpo ilegible se trata como intento fallido: no damos pistas de más.
    const password = claveDelCuerpo(req.body);

    // Comparación en tiempo constante sobre los digests SHA-256: así el tiempo
    // de respuesta no depende de cuántos caracteres iniciales ha acertado el
    // intento (ni de la longitud de la clave real: los digests miden siempre
    // 32 bytes).
    const [digestIntento, digestReal] = await Promise.all([sha256(password), sha256(secreto)]);
    if (!igualesEnTiempoConstante(digestIntento, digestReal)) {
        anotarFallo(ip, Date.now());
        await sleep(RETARDO_FALLO_MS);
        return res.status(401).json({ error: 'Clave incorrecta.' });
    }

    // Acierto: se borra el rastro de fallos (el bloqueo es por fallos SEGUIDOS).
    intentos.delete(ip);

    const token = await crearToken(secreto);
    res.setHeader('Set-Cookie', cabeceraSetCookie(token));
    return res.status(204).end();
};
