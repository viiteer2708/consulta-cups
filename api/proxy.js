const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

// Puerta de acceso: esta función devuelve datos personales del SIPS (titular,
// consumos), así que NO se sirve nada sin cookie de sesión válida.
const { comprobarAcceso } = require('./_auth.js');

// ============================================================
// Conexión a SICOM: nodo fijado por conexión + rotación ante nodo roto
// (espejo del fix de dpc-comparador 757229a, 14-jul-2026)
// ============================================================
//
// SICOM vive tras el gateway de ODF (gateway.prod.odfenergia.es), que fija
// el nodo de backend POR CONEXIÓN TCP. Cuando un nodo está roto responde
// 403 {"error":"Ha ocurrido un error interno al consultar."} a TODAS las
// consultas de esa conexión mientras el resto de nodos funciona. Por eso:
// UNA conexión keep-alive por instancia; si responde 403/5xx se ROTA la
// conexión (socket nuevo → sorteo de nodo nuevo), se re-autentica por la
// nueva y se reintenta. Reintentar por el mismo socket repite nodo roto.
// ============================================================

// ============================================================
// TLS: el 16-jul-2026 caducó el certificado *.megaenergia.es que sirve el
// gateway y toda consulta murió con "certificate has expired" antes de
// llegar a la API. Mitigación quirúrgica: se tolera EXACTAMENTE ese error
// (CERT_HAS_EXPIRED) y solo si el certificado sigue perteneciendo al host
// esperado; cualquier otro fallo TLS (cadena inválida, hostname distinto,
// posible MITM) aborta como siempre. Cuando IT renueve el certificado la
// validación normal vuelve a pasar y este código queda dormido.
// ============================================================
class SicomHttpsAgent extends https.Agent {
    createConnection(options) {
        const socket = super.createConnection({ ...options, rejectUnauthorized: false });
        socket.once('secureConnect', () => {
            const authErr = socket.authorizationError;
            if (!authErr) return; // certificado válido: camino normal
            const cert = socket.getPeerCertificate();
            const host = options.servername || options.host;
            const idErr = tls.checkServerIdentity(host, cert);
            if (String(authErr) !== 'CERT_HAS_EXPIRED' || idErr) {
                socket.destroy(new Error(`TLS SICOM rechazado (${authErr}${idErr ? ' + ' + idErr.code : ''})`));
            }
        });
        return socket;
    }
}

// Además de tolerar CERT_HAS_EXPIRED, se aportan las CA intermedias del
// certificado de SICOM (api/_sicom-ca.js): el 18-jul ODF instaló el cert
// renovado SIN cadena y sin ellas Node falla con UNABLE_TO_VERIFY_LEAF_SIGNATURE
// (ese error se sigue rechazando — con las CA la validación completa pasa).
const SICOM_INTERMEDIATE_CAS = require('./_sicom-ca.js');

const AGENT_OPTS = {
    keepAlive: true,
    maxSockets: 1,
    keepAliveMsecs: 30000,
    ca: [...tls.rootCertificates, ...SICOM_INTERMEDIATE_CAS],
};
let sicomAgent = new SicomHttpsAgent(AGENT_OPTS);

function rotateSicomAgent() {
    const old = sicomAgent;
    sicomAgent = new SicomHttpsAgent(AGENT_OPTS);
    old.destroy();
}

let cachedToken = null;
let cachedTokenIssuedAt = 0; // epoch ms
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000; // renovar a los 50 min (caduca a los 60)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Petición HTTPS por el socket fijo. Devuelve { status, body } con el body ya leído. */
function sicomRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request(
            { host: u.hostname, path: u.pathname + u.search, method, agent: sicomAgent, headers },
            (res) => {
                let buf = '';
                res.on('data', (c) => (buf += c));
                res.on('end', () => resolve({ status: res.statusCode, body: buf }));
            }
        );
        // Un SICOM colgado debe LANZAR pronto (y activar el respaldo
        // Greening), no dejar la función viva hasta que la mate Vercel.
        req.setTimeout(5000, () => req.destroy(new Error('SICOM sin respuesta (timeout 5s)')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function getToken(forceFresh = false) {
    if (!forceFresh && cachedToken && Date.now() - cachedTokenIssuedAt < TOKEN_MAX_AGE_MS) {
        return cachedToken;
    }

    const apiBase = process.env.SICOM_API_BASE;
    const username = process.env.SICOM_USERNAME;
    const password = process.env.SICOM_PASSWORD;

    if (!apiBase || !username || !password) {
        throw new Error('Missing env vars: SICOM_API_BASE, SICOM_USERNAME, or SICOM_PASSWORD');
    }

    // SIEMPRE por el socket fijo: el token queda registrado en el nodo al
    // que está pegada esta conexión, que es donde irán las consultas.
    const res = await sicomRequest(`${apiBase}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });

    if (res.status !== 200) {
        throw new Error(`Auth failed (${res.status}): ${res.body}`);
    }

    const data = JSON.parse(res.body);
    const authField = data.authorization || data.token || data.access_token || '';
    cachedToken = authField.replace(/^Bearer\s+/i, '');
    if (!cachedToken) throw new Error('No token in auth response');

    cachedTokenIssuedAt = Date.now();
    return cachedToken;
}

// ============================================================
// Respaldo SIPS vía GreeningEnergy (solo ELECTRICIDAD)
// ============================================================
//
// Desde el 16/17-jul-2026 SICOM está caído (certificado caducado + usuario
// API rechazado). Mientras ODF lo arregla, las consultas de electricidad se
// sirven desde la API de GreeningEnergy (la misma que usan Gnew y
// kleen-calculadora), devolviendo los datos EN LA FORMA DE SICOM para que
// index.html funcione sin cambios. Gas NO: Greening no tiene datos de gas.
// Responde cifrada (AES-256-CBC) cuando llega el header `x-iv`; la clave se
// deriva con PBKDF2(api_key, salt). Env: GREENINGENERGY_API_KEY + _SALT_B64.
// ============================================================

function greeningConfigurado() {
    return Boolean(process.env.GREENINGENERGY_API_KEY && process.env.GREENINGENERGY_SALT_B64);
}

async function greeningGet(path) {
    const apiKey = process.env.GREENINGENERGY_API_KEY.trim();
    const res = await fetch('https://api.greeningenergy.com' + path, { headers: { 'x-api-key': apiKey } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`Greening HTTP ${res.status}: ${buf.toString('utf8').slice(0, 200)}`);
    const iv = res.headers.get('x-iv');
    if (!iv) return JSON.parse(buf.toString('utf8'));
    const salt = Buffer.from(process.env.GREENINGENERGY_SALT_B64.trim(), 'base64');
    const clave = crypto.pbkdf2Sync(apiKey, salt, 100000, 32, 'sha256');
    const d = crypto.createDecipheriv('aes-256-cbc', clave, Buffer.from(iv, 'base64'));
    return JSON.parse(Buffer.concat([d.update(buf), d.final()]).toString('utf8'));
}

const numero = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// `ClientesSips[0]` de Greening → forma SICOM `sips/info` (electricidad).
// Greening da las potencias contratadas en kW pese al sufijo "EnW" del campo
// (verificado contra su endpoint `info`); SICOM las da en W → ×1000. La
// PotenciaMaximaBIEW de Greening SÍ viene en W (va tal cual). El código ATR
// llega con cero inicial ("019") y SICOM lo da sin él ("19").
function mapearInfoElec(raw, cups) {
    const c = raw && raw.ClientesSips && raw.ClientesSips[0];
    if (!c) return null;
    const salida = { cups, nombreEmpresaDistribuidora: c.NombreEmpresaDistribuidora || '' };
    const atr = numero(c.CodigoTarifaATREnVigor);
    if (atr > 0) salida.codigoTarifaATREnVigor = String(atr);
    for (let i = 1; i <= 6; i++) salida[`potenciasContratadasEnWP${i}`] = numero(c[`PotenciasContratadasEnWP${i}`]) * 1000;
    if (numero(c.PotenciaMaximaBIEW) > 0) salida.potenciaMaximaBIEW = numero(c.PotenciaMaximaBIEW);
    const tension = numero(c.CodigoTensionV);
    if (tension > 0) salida.codigoTensionV = tension;
    if (c.FechaUltimaLectura) salida.fechaUltimaLectura = c.FechaUltimaLectura;
    if (c.Cnae) salida.CNAE = c.Cnae;
    return salida;
}

// `info` de Greening → forma SICOM `sips/consumo/anual` (ConsumoPeriodos =
// desglose anual P1..P6 en kWh). Sin ventana de fechas: index.html la omite.
function mapearConsumoAnual(info) {
    if (!info) return null;
    const periodos = info.ConsumoPeriodos || {};
    const salida = { unidad: 'kWh' };
    let suma = 0;
    for (let i = 1; i <= 6; i++) {
        const v = numero(periodos[`P${i}`]);
        salida[`consumoAnualP${i}`] = v;
        suma += v;
    }
    const total = numero(info.ConsumoEstimado) || suma;
    if (total <= 0) return null;
    salida.consumoAnual = total;
    return salida;
}

// `info/consumo` de Greening (12 filas mensuales) → forma SICOM
// `sips/consumo`. Potencia1..6 (maxímetros, kW) → potenciaDemandadaEnWPi (W).
function mapearConsumoMensual(rows, cups) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.map((r) => {
        const fecha = String(r.Fecha || '');
        const mes = fecha.slice(0, 7); // "2026-03"
        const fila = {
            cups,
            fechaInicioMesConsumo: mes ? mes + '-01' : '',
            fechaFinMesConsumo: fecha,
        };
        for (let i = 1; i <= 6; i++) fila[`potenciaDemandadaEnWP${i}`] = numero(r[`Potencia${i}`]) * 1000;
        return fila;
    });
}

// Devuelve el payload EN FORMA SICOM para el endpoint pedido, o null si no
// puede (gas, sin CUPS, sin credenciales, o Greening sin datos).
async function respaldoGreening(endpoint, params) {
    const linea = params.linea || 'electricidad';
    const cups = params.cups;
    if (linea !== 'electricidad' || !cups || !greeningConfigurado()) return null;
    const q = encodeURIComponent(cups);
    if (endpoint === 'sips/info') return mapearInfoElec(await greeningGet(`/api/public/sips/info/raw?cups=${q}`), cups);
    if (endpoint === 'sips/consumo/anual') return mapearConsumoAnual(await greeningGet(`/api/public/sips/info?cups=${q}`));
    if (endpoint === 'sips/consumo') return mapearConsumoMensual(await greeningGet(`/api/public/sips/info/consumo?cups=${q}`), cups);
    return null;
}

module.exports = async (req, res) => {
    // Lo PRIMERO, antes de mirar siquiera los parámetros: sin sesión válida no
    // se consulta el SIPS. `comprobarAcceso` es fail-closed en producción (sin
    // ACCESS_PASSWORD responde 503, no abre).
    const rechazo = await comprobarAcceso(req);
    if (rechazo) return res.status(rechazo.status).json(rechazo.body);

    const { endpoint, ...params } = req.query;
    if (!endpoint) return res.status(400).json({ error: 'endpoint parameter required' });

    // Only allow known SIPS endpoints (exact whitelist)
    const ALLOWED_ENDPOINTS = ['sips/info', 'sips/consumo', 'sips/consumo/anual'];
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
        return res.status(403).json({ error: 'forbidden endpoint' });
    }

    // Validate CUPS format if provided
    if (params.cups && !/^ES\d{16,20}\w{0,4}$/i.test(params.cups)) {
        return res.status(400).json({ error: 'invalid CUPS format' });
    }

    try {
        let apiRes;
        try {
            let token = await getToken();

            const qs = new URLSearchParams(params).toString();
            const url = `${process.env.SICOM_API_BASE}/${endpoint}${qs ? '?' + qs : ''}`;

            const fetchOnce = () =>
                sicomRequest(url, {
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                });

            // 403/5xx = conexión pegada a un nodo roto → rotar socket + re-auth +
            // reintento. 401 = token caducado: mismo tratamiento.
            const isTransient = (r) => r.status === 401 || r.status === 403 || r.status >= 500;
            const waits = [250, 500, 1000];

            apiRes = await fetchOnce();
            for (let intento = 0; intento < waits.length && isTransient(apiRes); intento++) {
                rotateSicomAgent();
                try {
                    token = await getToken(true);
                } catch (e) {
                    // Si la re-auth falla, probamos igualmente con el token actual:
                    // los tokens parecen compartidos entre nodos.
                }
                await sleep(waits[intento]);
                apiRes = await fetchOnce();
            }
        } catch (sicomErr) {
            // SICOM inalcanzable (auth caída, red, TLS): probar el respaldo
            // Greening; si tampoco puede, propagar el error SICOM original.
            const respaldo = await respaldoGreening(endpoint, params).catch((e) => {
                console.warn(`Respaldo Greening falló (${endpoint}):`, e.message);
                return null;
            });
            if (respaldo == null) throw sicomErr;
            res.setHeader('x-sips-source', 'greening');
            return res.status(200).json(respaldo);
        }

        if (apiRes.status !== 200) {
            // Fallo de infraestructura SICOM → respaldo Greening (solo
            // electricidad). Un 400/404 es respuesta legítima: va tal cual.
            const esInfra = apiRes.status === 401 || apiRes.status === 403 || apiRes.status >= 500;
            const respaldo = esInfra ? await respaldoGreening(endpoint, params).catch(() => null) : null;
            if (respaldo != null) {
                res.setHeader('x-sips-source', 'greening');
                return res.status(200).json(respaldo);
            }
            return res.status(apiRes.status).send(apiRes.body);
        }

        const json = JSON.parse(apiRes.body);
        return res.status(200).json(json);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
