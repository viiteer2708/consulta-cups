const https = require('https');

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

const AGENT_OPTS = { keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 };
let sicomAgent = new https.Agent(AGENT_OPTS);

function rotateSicomAgent() {
    const old = sicomAgent;
    sicomAgent = new https.Agent(AGENT_OPTS);
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

module.exports = async (req, res) => {
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

        let apiRes = await fetchOnce();
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

        if (apiRes.status !== 200) {
            return res.status(apiRes.status).send(apiRes.body);
        }

        const json = JSON.parse(apiRes.body);
        return res.status(200).json(json);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
