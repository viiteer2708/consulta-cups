# Consulta masiva de CUPS (modo Lote) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un modo "Lote" a `index.html` que procese muchos CUPS de una vez y produzca un inventario de datos crudos de SICOM exportable a CSV.

**Architecture:** Todo vive en el IIFE de `index.html`, reutilizando los helpers existentes (`safeGet`, `apiGet`, `fmt`, `wToKw`, `mwhToKwh`, `getTarifa`, `getPicosMaximos`, `escapeHtml`). Un toggle `Individual | Lote` alterna entre la consulta actual y la nueva. El navegador llama al proxy actual CUPS a CUPS con un pool de concurrencia; `api/proxy.js` no se toca. El optimizador no interviene.

**Tech Stack:** HTML5 + CSS3 + JavaScript vanilla (un solo archivo). Sin frameworks, sin npm, sin dependencias.

## Global Constraints

Cada tarea hereda implícitamente estas restricciones (valores literales del spec/CLAUDE.md):

- **Archivo único:** todo el código va en `index.html`. No crear archivos nuevos (salvo los docs de `docs/superpowers/`). No tocar `api/proxy.js` (excepción aprobada 2026-06-27: ampliar la regex CUPS a `\w{0,4}`, ver más abajo).
- **Sin dependencias:** vanilla JS puro. Sin frameworks, sin npm, sin librerías (descarta XLSX → el export es CSV).
- **Validación CUPS:** `/^ES\d{16,20}\w{0,4}$/i` (la misma del proxy; ampliada de `{0,2}` a `{0,4}` el 2026-06-27 para admitir CUPS de 22 con punto frontera — cambio aplicado también en `api/proxy.js` para mantener consistencia).
- **Unidades:** potencias W→kW (`/1000`); consumo MWh→kWh (`×1000`) solo cuando `data.unidad` contenga "mwh".
- **Concurrencia:** 4 peticiones simultáneas.
- **Export:** CSV con separador `;` + BOM UTF-8 (`﻿`), con fila de cabecera en español. Nombre `inventario-{luz|gas}-AAAA-MM-DD.csv`. Números con coma decimal y sin separador de miles.
- **Sin framework de tests:** la verificación es **manual en navegador** (abrir `index.html`), con pasos y resultado esperado concretos en cada tarea.
- **Git:** `git add` + `git commit` permitidos. `git push` PROHIBIDO (lo hace Victor). Commits frecuentes, uno por tarea.
- **Diseño:** primario `#2563eb`, gas `#f97316`, radius `12px`, sombras sutiles existentes.

**Cómo verificar (común a todas las tareas):** abrir `index.html` directamente en el navegador (doble clic o `file://`). Las llamadas al proxy solo funcionan en producción (`consulta-cups.vercel.app`), así que la verificación end-to-end con datos reales (Tasks 3-7) se hace contra la versión desplegada o documentando el resultado esperado; la verificación de UI y parseo (Tasks 1-2) funciona en local sin red.

---

### Task 1: Chasis del modo `Individual | Lote`

**Files:**
- Modify: `index.html` (HTML dentro de `.search-card`, CSS en `<style>`, JS en el IIFE)

**Interfaces:**
- Consumes: nada.
- Produces: variable de estado `modo` (`'individual'|'lote'`); función `setModo(modo)`; contenedores DOM `#modoIndividual`, `#modoLote`, `#loteOutput`.

- [ ] **Step 1: Añadir el toggle de modo y los contenedores en el HTML**

En `index.html`, dentro de `.search-card`, justo después de `<p>...</p>` (la línea con "Introduce el código CUPS...") y ANTES de `<div class="search-row">`, insertar el toggle de modo. Después, envolver el bloque existente (`search-row` + `type-badge`) en `<div id="modoIndividual">`, y añadir el panel de lote oculto:

```html
        <div class="toggle-group mode-toggle" id="modoToggle">
            <button class="toggle-btn active" data-modo="individual">Individual</button>
            <button class="toggle-btn" data-modo="lote">Lote (varios CUPS)</button>
        </div>
        <div id="modoIndividual">
            <div class="search-row">
                <!-- ...contenido search-row existente sin cambios... -->
            </div>
            <div class="type-badge" id="typeBadge">
                <span id="typeBadgeText"></span>
            </div>
        </div>
        <div id="modoLote" style="display:none">
            <div class="toggle-group lote-tipo" id="loteTipoToggle" style="max-width:320px;margin-bottom:1rem">
                <button class="toggle-btn active" data-value="electricidad">Electricidad</button>
                <button class="toggle-btn" data-value="gas">Gas</button>
            </div>
            <textarea id="loteInput" class="lote-input" rows="6"
                placeholder="Pega aquí los CUPS (uno por línea) o pega varias columnas desde Excel (CUPS en la primera columna)."></textarea>
            <div class="lote-actions">
                <label class="btn btn-ghost" for="loteFile">Subir CSV/TXT</label>
                <input type="file" id="loteFile" accept=".csv,.txt" hidden>
                <button class="btn btn-primary" id="loteProcesarBtn">Procesar lote</button>
                <button class="btn btn-ghost" id="loteCancelarBtn" style="display:none">Cancelar</button>
            </div>
        </div>
```

Mover el `type-badge` existente dentro de `#modoIndividual` (quitarlo de su sitio actual si quedó fuera). El `#results`, `#errorMsg` y `#loader` ya existentes se quedan donde están (pertenecen al modo individual). Tras `</main>`-interno, después del bloque `#results`, añadir el contenedor de salida del lote:

```html
        <div id="loteOutput" style="display:none"></div>
```

(colócalo dentro de `<main class="main">`, después de `<div class="results" id="results">...</div>`).

- [ ] **Step 2: Añadir el CSS del modo lote**

En el `<style>`, tras el bloque `/* -- Optimizador económico: desglose -- */` (antes de `@media (max-width: 600px)`), añadir:

```css
        /* -- Modo Lote -- */
        .mode-toggle { max-width: 360px; margin: 0 auto 1.5rem; }
        .lote-input {
            width: 100%; border: 2px solid var(--border); border-radius: var(--radius);
            padding: .85rem 1rem; font-size: .9rem; font-family: 'SF Mono','Cascadia Code','Consolas',monospace;
            resize: vertical; outline: none; transition: border-color .2s, box-shadow .2s;
        }
        .lote-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-light); }
        .lote-actions { display: flex; gap: .75rem; align-items: center; margin-top: 1rem; flex-wrap: wrap; }
        .btn-ghost { background: var(--surface); color: var(--text); border: 2px solid var(--border); }
        .btn-ghost:hover { border-color: var(--primary); color: var(--primary); }
        .lote-progress { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.25rem; margin: 1.5rem 0; }
        .lote-progress__bar-track { height: 8px; border-radius: 4px; background: var(--bg); overflow: hidden; margin-top: .6rem; }
        .lote-progress__bar { height: 100%; background: var(--primary); width: 0; transition: width .3s ease; }
        .lote-table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; margin-bottom: 1rem; }
        .lote-table { width: 100%; border-collapse: collapse; font-size: .8rem; white-space: nowrap; }
        .lote-table th { background: var(--bg); padding: .55rem .7rem; text-align: left; font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); border-bottom: 1px solid var(--border); position: sticky; top: 0; }
        .lote-table td { padding: .5rem .7rem; border-bottom: 1px solid var(--border); }
        .lote-estado { font-weight: 700; font-size: .72rem; }
        .lote-estado.ok { color: var(--accent); }
        .lote-estado.parcial { color: var(--gas); }
        .lote-estado.sin { color: var(--text-muted); }
        .lote-estado.error, .lote-estado.invalido { color: var(--danger); }
```

- [ ] **Step 3: Añadir el estado y el cambio de modo en el JS**

En el IIFE, junto a las otras declaraciones (`let selectedLinea = 'electricidad';` etc.), añadir:

```javascript
    let modo = 'individual';
    let loteLinea = 'electricidad';
    const modoToggle = $('#modoToggle');
    const loteTipoToggle = $('#loteTipoToggle');

    function setModo(nuevo) {
        modo = nuevo;
        modoToggle.querySelectorAll('.toggle-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.modo === nuevo));
        $('#modoIndividual').style.display = nuevo === 'individual' ? '' : 'none';
        $('#modoLote').style.display = nuevo === 'lote' ? '' : 'none';
        $('#results').classList.remove('show');
        hideError();
        $('#loteOutput').style.display = nuevo === 'lote' ? '' : 'none';
    }
    modoToggle.addEventListener('click', (e) => {
        const b = e.target.closest('.toggle-btn'); if (!b) return;
        setModo(b.dataset.modo);
    });
    loteTipoToggle.addEventListener('click', (e) => {
        const b = e.target.closest('.toggle-btn'); if (!b) return;
        loteTipoToggle.querySelectorAll('.toggle-btn').forEach(x => x.classList.remove('active', 'gas-active'));
        b.classList.add('active');
        loteLinea = b.dataset.value;
        if (loteLinea === 'gas') b.classList.add('gas-active');
    });
```

- [ ] **Step 4: Verificar en el navegador**

Abrir `index.html`. Resultado esperado:
- Se ve el toggle `Individual | Lote` centrado bajo el subtítulo.
- En `Individual` (por defecto): se ve el buscador de un CUPS como siempre.
- Al pulsar `Lote`: desaparece el buscador individual y aparecen el toggle Electricidad/Gas, el textarea, "Subir CSV/TXT" y "Procesar lote".
- Al pulsar `Gas` dentro del lote, el botón se pinta naranja (`gas-active`).
- Al volver a `Individual`, reaparece el buscador y se oculta el panel de lote.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Modo Lote: chasis UI (toggle Individual|Lote + panel de entrada)"
```

---

### Task 2: `parseLoteInput` — parseo de entrada (pegado + archivo)

**Files:**
- Modify: `index.html` (JS en el IIFE; wiring del botón y del input file)

**Interfaces:**
- Consumes: nada.
- Produces: `parseLoteInput(texto) -> { cabeceras: string[], items: Array<{cups, extra: object, estado}> }`. `estado` vale `'pendiente'` o `'invalido'`. `cabeceras` son los nombres de las columnas extra (vacío si no hay).

- [ ] **Step 1: Implementar `parseLoteInput`**

Añadir en el IIFE (cerca del final, antes de `// -- Events --`):

```javascript
    const CUPS_RE = /^ES\d{16,20}\w{0,4}$/i;

    // Parsea texto pegado (incl. desde Excel) o el contenido de un CSV/TXT.
    // 1ª columna = CUPS; el resto = columnas extra. Si la 1ª fila no trae un CUPS, son cabeceras.
    function parseLoteInput(texto) {
        const lineas = (texto || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (!lineas.length) return { cabeceras: [], items: [] };

        const splitCols = (l) => l.includes('\t') ? l.split('\t')
            : (l.includes(';') ? l.split(';') : (l.includes(',') ? l.split(',') : [l]));

        let cabeceras = [];
        let start = 0;
        const primeraCols = splitCols(lineas[0]).map(c => c.trim());
        const primeraCupsNorm = primeraCols[0].toUpperCase().replace(/\s/g, '');
        if (!CUPS_RE.test(primeraCupsNorm)) {            // la 1ª fila son cabeceras
            cabeceras = primeraCols.slice(1);
            start = 1;
        }

        const items = [];
        const vistos = new Set();
        for (let i = start; i < lineas.length; i++) {
            const cols = splitCols(lineas[i]).map(c => c.trim());
            const cups = cols[0].toUpperCase().replace(/\s/g, '');
            if (!cups || vistos.has(cups)) continue;      // dedup por CUPS
            vistos.add(cups);
            const extra = {};
            cols.slice(1).forEach((v, idx) => { extra[cabeceras[idx] || `Extra ${idx + 1}`] = v; });
            items.push({ cups, extra, estado: CUPS_RE.test(cups) ? 'pendiente' : 'invalido' });
        }
        // Normaliza el set de cabeceras al máximo nº de extras encontrado
        const maxExtra = items.reduce((m, it) => Math.max(m, Object.keys(it.extra).length), cabeceras.length);
        const cabFinal = [];
        for (let i = 0; i < maxExtra; i++) cabFinal.push(cabeceras[i] || `Extra ${i + 1}`);
        return { cabeceras: cabFinal, items };
    }
```

- [ ] **Step 2: Wiring del input file → textarea**

Añadir el listener que carga un archivo en el textarea:

```javascript
    $('#loteFile').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { $('#loteInput').value = reader.result; };
        reader.readAsText(f, 'UTF-8');
    });
```

- [ ] **Step 3: Wiring temporal del botón Procesar para verificar el parseo**

Añadir un listener provisional (se sustituye en la Task 3) que muestre el conteo:

```javascript
    $('#loteProcesarBtn').addEventListener('click', () => {
        const { cabeceras, items } = parseLoteInput($('#loteInput').value);
        const validos = items.filter(it => it.estado === 'pendiente').length;
        const invalidos = items.length - validos;
        $('#loteOutput').innerHTML = `<div class="lote-progress">Detectados <strong>${items.length}</strong> CUPS únicos: `
            + `${validos} válidos, ${invalidos} con formato inválido. Cabeceras extra: ${cabeceras.length ? cabeceras.join(', ') : '—'}.</div>`;
    });
```

- [ ] **Step 4: Verificar en el navegador**

Abrir `index.html`, ir a `Lote`, pegar este texto en el textarea y pulsar "Procesar lote":

```
CUPS	Dirección
ES0021000009693104NG	Calle Mayor 1
ES0021000009693104NG	Calle Mayor 1 (duplicado)
ES1234	Piso mal
ES0031405935926001JN0F	Local B
```

Resultado esperado: "Detectados **3** CUPS únicos: 2 válidos, 1 con formato inválido. Cabeceras extra: Dirección." (el duplicado se descarta; `ES1234` es inválido; la fila de cabecera no cuenta como CUPS).

Probar también pegar solo una lista sin cabecera (un CUPS por línea) → "Cabeceras extra: —".

Probar "Subir CSV/TXT" con un `.txt` que contenga CUPS → el contenido aparece en el textarea.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Modo Lote: parseo de entrada (pegado/Excel/CSV) con validación y dedup"
```

---

### Task 3: Motor de proceso — pool de concurrencia, progreso y cancelar

**Files:**
- Modify: `index.html` (JS en el IIFE; sustituye el listener provisional de la Task 2)

**Interfaces:**
- Consumes: `parseLoteInput`, `apiGet`, `safeGet`.
- Produces: `getConRetry(endpoint, params)`; `runPool(items, worker, concurrency, onProgress, isCancelled)`; `procesarUno(item, tipo)` (devuelve una fila con `estado` final, de momento SIN columnas de datos); `procesarLote()` (orquesta UI + pool). Variable `loteCancelado`.

- [ ] **Step 1: Implementar el pool y el fetch con reintento**

Añadir en el IIFE:

```javascript
    let loteCancelado = false;

    // apiGet lanza en error HTTP/red y devuelve null en "sin datos". Reintenta 1× solo ante error.
    async function getConRetry(endpoint, params) {
        for (let intento = 0; intento < 2; intento++) {
            try { return await apiGet(endpoint, params); }
            catch (e) { if (intento === 1) throw e; }
        }
    }

    async function runPool(items, worker, concurrency, onProgress, isCancelled) {
        const results = new Array(items.length);
        let idx = 0, done = 0;
        async function next() {
            while (idx < items.length) {
                if (isCancelled()) return;
                const i = idx++;
                results[i] = await worker(items[i], i);
                done++;
                onProgress(done, items.length);
            }
        }
        const n = Math.min(concurrency, items.length);
        await Promise.all(Array.from({ length: n }, next));
        return results;
    }
```

- [ ] **Step 2: Implementar `procesarUno` (estado, sin columnas todavía)**

```javascript
    async function procesarUno(item, tipo) {
        if (item.estado === 'invalido') return Object.assign({}, item, { estado: 'invalido' });
        const endpoints = tipo === 'electricidad'
            ? [['sips/info', { cups: item.cups }],
               ['sips/consumo/anual', { linea: 'electricidad', cups: item.cups }],
               ['sips/consumo', { linea: 'electricidad', cups: item.cups }]]
            : [['sips/info', { cups: item.cups }],
               ['sips/consumo/anual', { linea: 'gas', cups: item.cups }]];
        const settled = await Promise.allSettled(endpoints.map(([e, p]) => getConRetry(e, p)));
        const vals = settled.map(s => s.status === 'fulfilled' ? s.value : null);
        const huboError = settled.some(s => s.status === 'rejected');
        const sinDatos = vals.every(v => v == null);
        let estado = sinDatos ? 'sin' : (huboError ? 'parcial' : 'ok');
        // Las columnas de datos se rellenan en la Task 4 (extraerFilaElec/Gas).
        return Object.assign({}, item, { estado, _raw: vals });
    }
```

- [ ] **Step 3: Implementar `procesarLote` (UI + pool + progreso + cancelar)**

Sustituir el listener provisional del botón de la Task 2 por:

```javascript
    $('#loteProcesarBtn').addEventListener('click', procesarLote);
    $('#loteCancelarBtn').addEventListener('click', () => { loteCancelado = true; });

    async function procesarLote() {
        const { cabeceras, items } = parseLoteInput($('#loteInput').value);
        if (!items.length) { $('#loteOutput').innerHTML = '<div class="lote-progress">No se han detectado CUPS.</div>'; return; }
        const tipo = loteLinea;
        const aviso = items.length > 200
            ? `<div class="opt-note" style="margin-bottom:1rem">⚠️ ${items.length} CUPS: el lote hará muchas llamadas y puede tardar varios minutos.</div>` : '';

        loteCancelado = false;
        $('#loteProcesarBtn').disabled = true;
        $('#loteCancelarBtn').style.display = '';
        $('#loteOutput').style.display = '';
        $('#loteOutput').innerHTML = aviso + `
            <div class="lote-progress">
                <div id="loteProgText">Procesando 0 / ${items.length}…</div>
                <div class="lote-progress__bar-track"><div class="lote-progress__bar" id="loteProgBar"></div></div>
            </div>
            <div id="loteResultados"></div>`;

        const onProgress = (done, total) => {
            $('#loteProgBar').style.width = (done / total * 100) + '%';
            $('#loteProgText').textContent = `Procesando ${done} / ${total}…`;
        };

        const filas = await runPool(items, (it) => procesarUno(it, tipo), 4, onProgress, () => loteCancelado);

        $('#loteProcesarBtn').disabled = false;
        $('#loteCancelarBtn').style.display = 'none';

        const hechas = filas.filter(Boolean);
        const cuenta = (s) => hechas.filter(f => f.estado === s).length;
        $('#loteProgText').innerHTML = `${loteCancelado ? '⏹️ Cancelado. ' : '✅ Hecho. '}`
            + `${cuenta('ok')} OK · ${cuenta('parcial')} parciales · ${cuenta('sin')} sin datos · ${cuenta('invalido')} inválidos.`;
        // El render de la tabla y el botón Exportar se añaden en las Tasks 5-6.
        window.__loteFilas = hechas; window.__loteCabeceras = cabeceras; window.__loteTipo = tipo; // temporal para depurar
    }
```

- [ ] **Step 4: Verificar (en producción o con resultado documentado)**

Como `apiGet` llama al proxy, verificar contra `consulta-cups.vercel.app` (o tras desplegar). Pegar 3-4 CUPS reales de luz + 1 inválido en `Lote → Electricidad` y "Procesar lote". Resultado esperado:
- La barra avanza de 0% a 100%.
- Al terminar: "✅ Hecho. N OK · … · 1 inválidos."
- Pulsando "Cancelar" a mitad de un lote grande: se detiene y muestra "⏹️ Cancelado." con los procesados hasta ese punto.

(En local sin red, verificar al menos que con solo un CUPS inválido el resumen dice "1 inválidos" sin quedarse colgado.)

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Modo Lote: motor de proceso (pool concurrencia 4, progreso, cancelar)"
```

---

### Task 4: `extraerFilaElec` / `extraerFilaGas` — columnas de datos crudos

**Files:**
- Modify: `index.html` (JS en el IIFE; ajustar `procesarUno` para usar las extractoras)

**Interfaces:**
- Consumes: `wToKw`, `mwhToKwh`, `getTarifa`, `getPicosMaximos`, `fmtDate`, `_raw` de `procesarUno`.
- Produces: `extraerFilaElec(info, consumo, max, item) -> fila`; `extraerFilaGas(info, consumo, item) -> fila`. La `fila` lleva `cups`, `extra`, `estado` y las claves de datos consumidas por las definiciones de columnas de la Task 5 (`tarifa`, `distribuidora`, `tension`, `cnae`, `pc[1..6]`, `bie`, `consumoTotal`, `ca[1..6]`, `pico[1..6]`, `ultimaLectura` para luz; `tarifa`, `distribuidora`, `caudalDiario`, `caudalHorario`, `presion`, `cp`, `cnae`, `consumoTotal`, `ultimaLectura` para gas).

- [ ] **Step 1: Implementar las extractoras**

Añadir en el IIFE (junto a `procesarUno`):

```javascript
    const TENSION_MAP = { 1: '1x230', 2: '1x230', 3: '3x380', 4: '3x380', 5: '3x380/220', 6: '3x380/220' };

    function consumoTotalKwh(consumo) {
        if (!consumo) return null;
        const isMwh = (consumo.unidad || '').toLowerCase().includes('mwh');
        const raw = consumo.consumoAnual ?? consumo.energiaActivaAnualTotal;
        if (raw == null) return null;
        return isMwh ? mwhToKwh(raw) : parseFloat(raw);
    }
    function consumoPeriodoKwh(consumo, i) {
        if (!consumo) return null;
        const isMwh = (consumo.unidad || '').toLowerCase().includes('mwh');
        const raw = consumo[`consumoAnualP${i}`] ?? consumo[`energiaActivaAnualP${i}`];
        if (raw == null) return null;
        return isMwh ? mwhToKwh(raw) : parseFloat(raw);
    }

    function extraerFilaElec(info, consumo, max, item) {
        const picos = getPicosMaximos(max); // {1..6} en W
        const fila = Object.assign({}, item);
        fila.tarifa = info ? (getTarifa(info) || '') : '';
        fila.distribuidora = info ? (info.nombreEmpresaDistribuidora || '') : '';
        fila.tension = info && info.codigoTensionV ? (TENSION_MAP[info.codigoTensionV] || `Cod. ${info.codigoTensionV}`) : '';
        fila.cnae = info && info.CNAE != null ? String(info.CNAE) : '';
        fila.bie = info ? wToKw(info.potenciaMaximaBIEW) : null;
        fila.pc = {}; fila.ca = {}; fila.pico = {};
        for (let i = 1; i <= 6; i++) {
            fila.pc[i] = info ? wToKw(info[`potenciasContratadasEnWP${i}`]) : null;
            fila.ca[i] = consumoPeriodoKwh(consumo, i);
            fila.pico[i] = picos[i] > 0 ? picos[i] / 1000 : null;
        }
        fila.consumoTotal = consumoTotalKwh(consumo);
        fila.ultimaLectura = info && info.fechaUltimaLectura ? fmtDate(info.fechaUltimaLectura) : '';
        return fila;
    }

    function extraerFilaGas(info, consumo, item) {
        const fila = Object.assign({}, item);
        fila.tarifa = info ? (info.codigoPeajeEnVigor || info.codigoTarifaATREnVigor || '') : '';
        fila.distribuidora = info ? (info.nombreEmpresaDistribuidora || '') : '';
        fila.caudalDiario = info && info.caudalMaximoDiarioEnWhDia != null ? info.caudalMaximoDiarioEnWhDia : '';
        fila.caudalHorario = info && info.caudalHorarioEnWh != null ? info.caudalHorarioEnWh : '';
        fila.presion = info && info.presionMedida != null ? info.presionMedida : '';
        fila.cp = info && info.codigoPostalPS != null ? String(info.codigoPostalPS) : '';
        fila.cnae = info && info.CNAE != null ? String(info.CNAE) : '';
        fila.consumoTotal = consumoTotalKwh(consumo);
        fila.ultimaLectura = info && info.fechaUltimaLectura ? fmtDate(info.fechaUltimaLectura) : '';
        return fila;
    }
```

- [ ] **Step 2: Conectar las extractoras en `procesarUno`**

En `procesarUno`, sustituir la línea final `return Object.assign({}, item, { estado, _raw: vals });` por:

```javascript
        if (estado === 'sin') return Object.assign({}, item, { estado: 'sin' });
        const fila = tipo === 'electricidad'
            ? extraerFilaElec(vals[0], vals[1], vals[2], item)
            : extraerFilaGas(vals[0], vals[1], item);
        fila.estado = estado; // 'ok' o 'parcial'
        return fila;
```

- [ ] **Step 3: Verificar (en producción)**

Procesar un lote de 2 CUPS de luz conocidos. En la consola del navegador inspeccionar `window.__loteFilas`:
- Cada fila tiene `tarifa`, `distribuidora`, `pc` (P1..P6 en kW), `pico` (P1..P6), `consumoTotal` (kWh).
- Comparar `consumoTotal` y `pc` de un CUPS con lo que muestra su consulta **Individual** → deben coincidir.
- Repetir con un CUPS de gas: la fila trae `caudalDiario`, `caudalHorario`, `presion`, `cp`, `consumoTotal`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Modo Lote: extracción de columnas de datos crudos (luz y gas)"
```

---

### Task 5: `renderLoteTabla` — tabla del inventario en pantalla

**Files:**
- Modify: `index.html` (JS en el IIFE; llamada desde `procesarLote`)

**Interfaces:**
- Consumes: filas de la Task 4, `escapeHtml`, `fmt`.
- Produces: `COLS_ELEC` / `COLS_GAS` (definición de columnas: `{label, get(fila)}`); `valorCelda(fila, tipo)`; `renderLoteTabla(filas, cabeceras, tipo)`.

- [ ] **Step 1: Definir las columnas (compartidas por tabla y CSV) y el render**

Añadir en el IIFE. `get(fila)` devuelve string ya formateado (números con coma decimal, vía `numES`):

```javascript
    function numES(n, dec) {
        if (n == null || isNaN(n)) return '';
        const r = Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
        return r.toString().replace('.', ',');
    }

    const COLS_ELEC = [
        { label: 'Tarifa', get: f => f.tarifa },
        { label: 'Distribuidora', get: f => f.distribuidora },
        { label: 'Tensión (V)', get: f => f.tension },
        { label: 'CNAE', get: f => f.cnae },
        ...Array.from({ length: 6 }, (_, k) => k + 1).map(i => ({ label: `P. contratada P${i} (kW)`, get: f => numES(f.pc[i], 2) })),
        { label: 'P. máx BIE (kW)', get: f => numES(f.bie, 2) },
        { label: 'Consumo anual (kWh)', get: f => numES(f.consumoTotal, 0) },
        ...Array.from({ length: 6 }, (_, k) => k + 1).map(i => ({ label: `Consumo anual P${i} (kWh)`, get: f => numES(f.ca[i], 0) })),
        ...Array.from({ length: 6 }, (_, k) => k + 1).map(i => ({ label: `Pico máx P${i} (kW)`, get: f => numES(f.pico[i], 2) })),
        { label: 'Última lectura', get: f => f.ultimaLectura }
    ];
    const COLS_GAS = [
        { label: 'Tarifa/Peaje', get: f => f.tarifa },
        { label: 'Distribuidora', get: f => f.distribuidora },
        { label: 'Caudal máx diario', get: f => String(f.caudalDiario ?? '') },
        { label: 'Caudal horario', get: f => String(f.caudalHorario ?? '') },
        { label: 'Presión', get: f => String(f.presion ?? '') },
        { label: 'CP', get: f => f.cp },
        { label: 'CNAE', get: f => f.cnae },
        { label: 'Consumo anual (kWh)', get: f => numES(f.consumoTotal, 0) },
        { label: 'Última lectura', get: f => f.ultimaLectura }
    ];
    const ESTADO_LABEL = { ok: 'OK', parcial: 'Parcial', sin: 'Sin datos', invalido: 'Formato inválido', error: 'Error API' };

    function colsDe(tipo) { return tipo === 'gas' ? COLS_GAS : COLS_ELEC; }

    function renderLoteTabla(filas, cabeceras, tipo) {
        const cols = colsDe(tipo);
        const head = ['CUPS', ...cabeceras, ...cols.map(c => c.label), 'Estado'];
        let html = '<div class="lote-table-wrap"><table class="lote-table"><thead><tr>'
            + head.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>';
        filas.forEach(f => {
            const datos = (f.estado === 'invalido' || f.estado === 'sin')
                ? cols.map(() => '')
                : cols.map(c => escapeHtml(c.get(f)));
            const extras = cabeceras.map(cab => escapeHtml((f.extra && f.extra[cab]) || ''));
            html += '<tr><td>' + escapeHtml(f.cups) + '</td>'
                + extras.map(v => `<td>${v}</td>`).join('')
                + datos.map(v => `<td>${v}</td>`).join('')
                + `<td><span class="lote-estado ${f.estado}">${ESTADO_LABEL[f.estado] || f.estado}</span></td></tr>`;
        });
        html += '</tbody></table></div>';
        return html;
    }
```

- [ ] **Step 2: Llamar al render desde `procesarLote`**

En `procesarLote`, tras la línea que escribe el resumen en `#loteProgText`, añadir antes de la línea temporal `window.__loteFilas`:

```javascript
        $('#loteResultados').innerHTML = renderLoteTabla(hechas, cabeceras, tipo);
```

- [ ] **Step 3: Verificar (en producción)**

Procesar un lote de luz (3 CUPS + 1 inválido). Resultado esperado:
- Aparece una tabla con columnas: CUPS, [extras si los hubo], Tarifa, Distribuidora, Tensión, CNAE, P. contratada P1-P6, P. máx BIE, Consumo anual, Consumo anual P1-P6, Pico máx P1-P6, Última lectura, Estado.
- La fila inválida muestra el CUPS y "Formato inválido" en rojo, con las celdas de datos vacías.
- Cambiar a Gas y procesar un lote de gas: la tabla muestra las columnas de gas (Caudal, Presión, CP…).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Modo Lote: tabla de inventario en pantalla (columnas luz/gas)"
```

---

### Task 6: `exportarCSV` — descarga del inventario

**Files:**
- Modify: `index.html` (JS en el IIFE; botón Exportar en `procesarLote`)

**Interfaces:**
- Consumes: `COLS_ELEC`/`COLS_GAS` (vía `colsDe`), `numES`, filas de la Task 4.
- Produces: `csvCell(v)`; `exportarCSV(filas, cabeceras, tipo)`.

- [ ] **Step 1: Implementar la generación y descarga del CSV**

Añadir en el IIFE:

```javascript
    function csvCell(v) {
        const s = v == null ? '' : String(v);
        return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function exportarCSV(filas, cabeceras, tipo) {
        const cols = colsDe(tipo);
        const head = ['CUPS', ...cabeceras, ...cols.map(c => c.label), 'Estado'];
        const lineas = [head.map(csvCell).join(';')];
        filas.forEach(f => {
            const datos = (f.estado === 'invalido' || f.estado === 'sin') ? cols.map(() => '') : cols.map(c => c.get(f));
            const extras = cabeceras.map(cab => (f.extra && f.extra[cab]) || '');
            const fila = [f.cups, ...extras, ...datos, ESTADO_LABEL[f.estado] || f.estado];
            lineas.push(fila.map(csvCell).join(';'));
        });
        const contenido = '﻿' + lineas.join('\r\n');
        const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inventario-${tipo === 'gas' ? 'gas' : 'luz'}-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    }
```

- [ ] **Step 2: Añadir el botón Exportar tras procesar**

En `procesarLote`, tras `$('#loteResultados').innerHTML = renderLoteTabla(...)`, añadir el botón y su listener (solo si hay filas exportables):

```javascript
        if (hechas.length) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-primary';
            btn.textContent = 'Exportar CSV';
            btn.style.marginBottom = '1rem';
            btn.addEventListener('click', () => exportarCSV(hechas, cabeceras, tipo));
            $('#loteResultados').insertBefore(btn, $('#loteResultados').firstChild);
        }
```

Eliminar ya la línea temporal de depuración `window.__loteFilas = ...` de la Task 3.

- [ ] **Step 3: Verificar (en producción)**

Procesar un lote de luz y pulsar "Exportar CSV". Resultado esperado:
- Se descarga `inventario-luz-AAAA-MM-DD.csv`.
- Al abrirlo en Excel español: las columnas quedan **separadas** (no todo en una celda), los acentos se ven bien (Tensión, Última, Presión), los números con coma decimal se interpretan como número.
- La fila de cabecera está en español y coincide con la tabla.
- Repetir con gas → `inventario-gas-AAAA-MM-DD.csv` con las columnas de gas.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Modo Lote: export a CSV (;+BOM, cabecera en español)"
```

---

### Task 7: Pulido final y verificación end-to-end

**Files:**
- Modify: `index.html` (ajustes menores)
- Modify: `claude.md` (documentar el modo Lote)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada nuevo.

- [ ] **Step 1: Limpiar restos temporales y revisar estados**

Verificar que ya no queda ninguna referencia a `window.__lote*` ni el listener provisional del botón de la Task 2. Confirmar que `procesarUno` nunca produce el estado `'error'` sin etiqueta (si una fila quedara con estado desconocido, `ESTADO_LABEL` cae al propio string — aceptable). Quitar imports/variables huérfanos que hayan quedado de pasos sustituidos.

- [ ] **Step 2: Documentar el modo Lote en `claude.md`**

En `claude.md`, en la sección de estructura/archivos clave, añadir una línea bajo "Archivos clave" o crear un apartado breve:

```markdown
## Modo Lote (consulta masiva, dentro de `index.html`)
Toggle `Individual | Lote`. Procesa muchos CUPS (pegados/Excel o CSV subido) en el cliente
contra el proxy actual (pool de 4, reintento 1×, cancelable), extrae datos crudos de SICOM
(luz o gas, elegido por lote) y exporta un inventario a CSV (`;`+BOM, cabecera en español).
No usa el optimizador. `api/proxy.js` no se toca.
```

- [ ] **Step 3: Verificación end-to-end completa (checklist del spec §9)**

Contra producción (o tras desplegar). Confirmar TODO:
1. Lote de **2-3 CUPS de luz reales + 1 inválido** → la barra llega a 100%; resumen correcto.
2. Los datos de una fila coinciden con la consulta **Individual** de ese CUPS.
3. El **CSV de luz** abre en Excel con columnas separadas y acentos correctos.
4. La fila del CUPS inválido sale como **"Formato inválido"** sin llamar a la API.
5. Lote de **gas** (2 llamadas/CUPS) → columnas de gas correctas y su CSV.
6. El botón **Cancelar** detiene un lote grande conservando lo procesado.
7. Volver a **Individual** y confirmar que la consulta de un CUPS sigue funcionando igual que antes.

- [ ] **Step 4: Commit**

```bash
git add index.html claude.md
git commit -m "Modo Lote: pulido final + documentación en claude.md"
```

---

## Self-Review

**1. Spec coverage:**
- Entrada pegar/Excel/CSV → Task 2 ✓
- Datos crudos luz/gas separados → Tasks 4-5 ✓
- Procesamiento en cliente, pool, progreso, reintentos, cancelar → Task 3 ✓
- Export CSV `;`+BOM cabecera español → Task 6 ✓
- UI modo Individual|Lote → Task 1 ✓
- Aviso >200 CUPS → Task 3 ✓
- Verificación manual (gap Karpathy) → Tasks 3-7 ✓
- Nota unidades de gas a verificar → Task 4 (las columnas de caudal se vuelcan crudas; el etiquetado se confirma en la verificación de la Task 4/7) ✓

**2. Placeholder scan:** sin TBD/TODO; todo el código está completo en cada paso.

**3. Type consistency:** `parseLoteInput` devuelve `{cabeceras, items}`, usado igual en Tasks 3-6. `procesarUno` produce filas con las claves que consumen `COLS_ELEC`/`COLS_GAS`. `colsDe(tipo)` se reutiliza en render (Task 5) y export (Task 6). `numES`/`csvCell`/`ESTADO_LABEL` definidos antes de su uso.

**Nota sobre `_raw`:** la Task 3 introduce `_raw` como campo intermedio de `procesarUno`; la Task 4 reescribe el `return` de `procesarUno` para no emitirlo (las filas finales no lo llevan). Verificado: no queda en la salida final.
