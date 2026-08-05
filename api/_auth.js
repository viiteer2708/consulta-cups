// ============================================================
// Sesión de acceso: cookie firmada, sin estado en servidor
// (mismo esquema que mega-calculadora/src/lib/auth/cookie.ts)
// ============================================================
//
// El token es `${expMs}.${firmaHex}`, donde la firma es
// HMAC-SHA256(String(expMs)) usando `ACCESS_PASSWORD` como clave. No hay tabla
// de sesiones: la propia cookie lleva su caducidad y la firma impide tocarla
// (cambiar `expMs` invalida la firma). Consecuencia buscada: **rotar
// ACCESS_PASSWORD invalida de golpe todas las sesiones vivas**.
//
// Todo con Web Crypto (`crypto.subtle`), igual que el patrón de referencia, no
// con las API clásicas de `node:crypto`.
// ============================================================

// `globalThis.crypto` existe en Node >= 19 (y en el runtime de Vercel). El
// respaldo `webcrypto` es la MISMA API Web Crypto, por si la función corriera
// en un Node más viejo.
const webcrypto = globalThis.crypto || require('node:crypto').webcrypto;

/** Nombre de la cookie de sesión. Ojo: también aparece en `vercel.json`. */
const COOKIE_ACCESO = 'cups_acceso';

/** Vida del token: 30 días. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** El mismo TTL en segundos, para el `Max-Age` de la cookie (2.592.000). */
const TTL_SEGUNDOS = TTL_MS / 1000;

/** Longitud en hex de un HMAC-SHA256 (32 bytes). */
const LONGITUD_FIRMA_HEX = 64;

const codificador = new TextEncoder();

/** Firma un mensaje con HMAC-SHA256 y devuelve el digest en bytes. */
async function firmar(mensaje, secreto) {
    const clave = await webcrypto.subtle.importKey(
        'raw',
        codificador.encode(secreto),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const firma = await webcrypto.subtle.sign('HMAC', clave, codificador.encode(mensaje));
    return new Uint8Array(firma);
}

/** SHA-256 de un texto, en bytes. Lo usa `api/acceso.js` para cotejar la clave. */
async function sha256(texto) {
    const digest = await webcrypto.subtle.digest('SHA-256', codificador.encode(texto));
    return new Uint8Array(digest);
}

function aHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hex → bytes. Devuelve null si el texto no es hex de longitud par. */
function desdeHex(hex) {
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Compara dos digests byte a byte SIN cortocircuito (acumulador XOR), para no
 * filtrar por tiempo cuántos bytes iniciales acertó quien lo intenta.
 * La longitud sí puede salir por la puerta rápida: es información pública
 * (un HMAC-SHA256 mide siempre 32 bytes).
 */
function igualesEnTiempoConstante(a, b) {
    if (a.length !== b.length) return false;
    let diferencia = 0;
    for (let i = 0; i < a.length; i++) diferencia |= a[i] ^ b[i];
    return diferencia === 0;
}

/** Crea un token válido durante `TTL_MS` a partir de ahora. */
async function crearToken(secreto) {
    const expMs = Date.now() + TTL_MS;
    const firma = await firmar(String(expMs), secreto);
    return `${expMs}.${aHex(firma)}`;
}

/**
 * Valida un token: formato, caducidad y firma. Devuelve `false` ante cualquier
 * duda — sin secreto, sin token, caducado o manipulado.
 */
async function verificarToken(token, secreto) {
    if (!token || !secreto) return false;

    const separador = token.indexOf('.');
    if (separador <= 0) return false;

    const expTexto = token.slice(0, separador);
    const firmaHex = token.slice(separador + 1);
    if (firmaHex.length !== LONGITUD_FIRMA_HEX) return false;

    // Solo dígitos y forma canónica: "0123" o "1e3" no valen aunque parseen.
    if (!/^\d+$/.test(expTexto)) return false;
    const expMs = Number(expTexto);
    if (!Number.isSafeInteger(expMs) || String(expMs) !== expTexto) return false;

    // Caducado (o justo en el límite) → fuera.
    if (expMs <= Date.now()) return false;

    const firmaRecibida = desdeHex(firmaHex);
    if (!firmaRecibida) return false;

    const firmaEsperada = await firmar(expTexto, secreto);
    return igualesEnTiempoConstante(firmaRecibida, firmaEsperada);
}

/**
 * Lee una cookie de la petición. Vercel expone `req.cookies` en el runtime de
 * Node, pero parseamos también la cabecera cruda para no depender de ello.
 */
function leerCookie(req, nombre) {
    if (req.cookies && typeof req.cookies[nombre] === 'string') return req.cookies[nombre];
    const cruda = req.headers && req.headers.cookie;
    if (!cruda) return undefined;
    for (const trozo of cruda.split(';')) {
        const sep = trozo.indexOf('=');
        if (sep < 0) continue;
        if (trozo.slice(0, sep).trim() === nombre) return trozo.slice(sep + 1).trim();
    }
    return undefined;
}

/** La cabecera `Set-Cookie` completa para un token recién creado. */
function cabeceraSetCookie(token) {
    return [
        `${COOKIE_ACCESO}=${token}`,
        'HttpOnly', // no la ve el JS del navegador
        'Secure',
        'SameSite=Lax',
        'Path=/',
        `Max-Age=${TTL_SEGUNDOS}`,
    ].join('; ');
}

/**
 * Puerta para las funciones de `api/`. Devuelve `null` si se puede pasar, o
 * `{ status, body }` con la respuesta de rechazo.
 *
 * Fail-closed (mismo criterio que `mega-calculadora/src/proxy.ts`): sin
 * `ACCESS_PASSWORD` en producción NO se abre; en desarrollo se avisa por
 * consola y se deja pasar para no bloquear el trabajo del día a día.
 */
async function comprobarAcceso(req) {
    const secreto = (process.env.ACCESS_PASSWORD || '').trim();

    if (!secreto) {
        if (process.env.NODE_ENV === 'development') {
            console.warn(
                '[acceso] ACCESS_PASSWORD no está definida: la herramienta queda ABIERTA en desarrollo.'
            );
            return null;
        }
        return {
            status: 503,
            body: {
                error:
                    'La herramienta no tiene clave configurada en el servidor (ACCESS_PASSWORD). Avisa a dirección.',
            },
        };
    }

    const token = leerCookie(req, COOKIE_ACCESO);
    if (await verificarToken(token, secreto)) return null;

    return { status: 401, body: { error: 'Sesión no válida. Vuelve a introducir la clave.' } };
}

module.exports = {
    COOKIE_ACCESO,
    TTL_MS,
    TTL_SEGUNDOS,
    sha256,
    igualesEnTiempoConstante,
    crearToken,
    verificarToken,
    leerCookie,
    cabeceraSetCookie,
    comprobarAcceso,
};
