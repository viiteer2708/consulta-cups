let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const apiBase = process.env.SICOM_API_BASE;
    const username = process.env.SICOM_USERNAME;
    const password = process.env.SICOM_PASSWORD;

    if (!apiBase || !username || !password) {
        throw new Error('Missing env vars: SICOM_API_BASE, SICOM_USERNAME, or SICOM_PASSWORD');
    }

    const res = await fetch(`${apiBase}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Auth failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    const authField = data.authorization || data.token || data.access_token || '';
    cachedToken = authField.replace(/^Bearer\s+/i, '');
    if (!cachedToken) throw new Error('No token in auth response');

    tokenExpiry = Date.now() + 3500 * 1000;
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
    if (params.cups && !/^ES\d{16,20}\w{0,2}$/i.test(params.cups)) {
        return res.status(400).json({ error: 'invalid CUPS format' });
    }

    try {
        let token = await getToken();

        // Build query string from remaining params (cups, linea, etc.)
        const qs = new URLSearchParams(params).toString();
        const url = `${process.env.SICOM_API_BASE}/${endpoint}${qs ? '?' + qs : ''}`;

        let apiRes = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (apiRes.status === 401) {
            cachedToken = null;
            token = await getToken();
            apiRes = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
        }

        if (!apiRes.ok) {
            const text = await apiRes.text();
            return res.status(apiRes.status).send(text);
        }

        const json = await apiRes.json();
        return res.status(200).json(json);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
