# CLAUDE.md - Consulta CUPS Mega Energía
**Herramienta web para comerciales de energía: consulta puntos de suministro (electricidad/gas) vía API SICOM.**

## Reglas de Oro
| Regla | Por qué |
|-------|---------|
| Archivo único `index.html` (HTML+CSS+JS) | Sin frameworks, sin bundler, zero-config |
| No crear archivos adicionales sin pedirlo | Proyecto intencionalmente minimalista |
| No usar frameworks ni npm | Vanilla JS puro, sin dependencias |
| Si API devuelve MWh → convertir a kWh (×1000) | Los comerciales trabajan en kWh |
| Cachear Bearer token en memoria (3600s vida) | Evitar llamadas de auth innecesarias |
| Whitelist de endpoints en proxy | Seguridad: solo sips/info, sips/consumo, sips/consumo/anual |
| Validar formato CUPS: `ES\d{16,20}\w{0,2}` | Evitar inyección y llamadas inválidas a API |

## Stack
- HTML5 + CSS3 + JavaScript vanilla (archivo único)
- API REST SICOM Mega Energía (auth Bearer token, 3600s TTL)
- Vercel Serverless Function (proxy en `api/proxy.js`)
- Variables de entorno: `SICOM_API_BASE`, `SICOM_USERNAME`, `SICOM_PASSWORD`

## Estructura
```
consulta-cups/
├── index.html          ← UI completa (HTML + CSS + JS)
├── api/
│   └── proxy.js        ← Serverless proxy → API SICOM
├── CLAUDE.md
├── .gitignore
└── .env (no commiteado)
```

## Archivos clave
| Archivo | Qué hace |
|---------|----------|
| `index.html` | Toda la UI: formulario CUPS, toggle luz/gas, resultados, estilos |
| `api/proxy.js` | Proxy seguro: auth token cacheado, whitelist endpoints, validación CUPS |

## API SICOM
- **Base URL prod:** `https://sicom.megaenergia.es/sicom/api/1.0`
- **Auth:** POST `/auth/token` → Bearer token (válido 3600s)
- **Endpoints:** `/sips/info`, `/sips/consumo/anual`, `/sips/consumo`
- **Proxy local:** `/api/proxy?endpoint=sips/info&cups=ES...`

## Optimizador de potencias (módulo principal, dentro de `index.html`)
**Objetivo:** recomendar la potencia que MINIMIZA el coste anual (término de potencia + penalizaciones por exceso), NO la que cubre el pico. Optimizar = pagar lo mínimo, aceptando los excesos que compensen. La "potencia optimizada" = máximo ahorro; cubrir el pico (0 excesos) es la "por defecto", no la óptima.

**Tres caminos según tarifa y datos disponibles:**
- **3.0TD / 6.X con maxímetro → optimizador ECONÓMICO (con €).** Backtest sobre el maxímetro mensual real de los últimos 12 meses; programación dinámica que minimiza Σ(término + excesos·λ) con la restricción legal P1≤P2≤…≤P6. Slider "Estrategia de potencia": ⭐ Potencia optimizada (máximo ahorro, arranca aquí) ↔ a la izquierda cubrir pico (conservador) / a la derecha agresivo. Garantía: la contratada actual siempre está en el espacio de búsqueda → el ahorro nunca es negativo.
- **2.0TD con maxímetro → conservador** (cubre pico + margen ajustable, sin €).
- **2.0TD sin maxímetro → calculadora por electrodomésticos** (modelo de simultaneidad REBT ITC-BT-25 / método OCU).

**Normativa (verificada al texto del BOE — Circular CNMC 3/2020):**
- En TD el término de potencia se factura al 100% de la contratada. La banda del maxímetro 85-105% está DEROGADA (no aplicar).
- NO hay mínimo de potencia por periodo. En 3.0TD solo la potencia MAYOR (P6, por la monotonía ascendente) debe superar 15 kW. En 6.X ni eso (la tarifa se define por nivel de tensión, no por potencia). P1=1 kW es válido.
- 2.0TD: control por ICP, sin excesos facturables. 3.0TD/6.X: excesos aparte. Fórmula tipo 4-5 (3.0TD, exacta con el dato de SICOM): `penalización_mes_p = tep_p[€/kW·día] · (maxímetro − contratada) · días`. La `tep` YA incluye el factor 1,4064 → NO multiplicar otra vez. En 6.X la ley usa cuarto-horario (no replicable con el maxímetro mensual) → los excesos son ESTIMACIÓN, avisado en pantalla.

**Precios `PRECIOS_POT_2026` (€/kW·año, peaje+cargo) y `TEP_EXC_2026` (€/kW·día):** verificados dígito a dígito contra BOE-A-2025-26348 + Orden de cargos 2026. **⚠️ Actualizar cada enero** con la nueva resolución de la CNMC (las dos tablas, por tarifa 3.0TD/6.1-6.4TD y periodo P1..P6).

**Datos que usa de la API:** `potenciasContratadasEnWP1..6` (sips/info) + `potenciaDemandadaEnWP1..6` por mes (sips/consumo = maxímetro mensual por periodo).

**Producción:** **https://consulta-cups.vercel.app** (proyecto Vercel `consulta-cups`; despliega solo al hacer push a `master`). Para auditar un CUPS sin la web: `curl -sG https://consulta-cups.vercel.app/api/proxy --data-urlencode 'endpoint=sips/consumo' --data-urlencode 'cups=ES...'`.

## Flujo de trabajo
1. Editar `index.html` directamente para cambios de UI/lógica
2. Editar `api/proxy.js` para cambios en el proxy/API
3. Probar localmente abriendo `index.html` en navegador
4. Commit → Victor hace push manual → Vercel despliega automáticamente

## Design system
- **Primario:** `#2563eb` (azul) · **Accent:** `#10b981` (verde)
- **Gas:** `#f97316` (naranja) · **Electricidad:** `#2563eb` (azul)
- **Font:** system stack (-apple-system, Segoe UI, Inter)
- **Border radius:** 12px · **Sombras:** sutiles (shadow, shadow-lg)

## Reglas de Ejecución
**PROHIBIDO sin pedir permiso:**
- git push (Victor hace push manualmente)
- rm -rf / borrar archivos
- Levantar servidores de desarrollo
- Modificar configuración de Vercel/hosting
- Crear archivos nuevos (proyecto single-file)
- Instalar dependencias (proyecto sin node_modules)

**PERMITIDO sin preguntar:**
- Leer/escribir `index.html` y `api/proxy.js`
- git add, git commit

---

## Vault de Obsidian (contexto transversal)
Este proyecto está conectado con mi vault de Obsidian en `/mnt/c/Users/viite/Documents/OBSIDIAN/VIITEER`.

Si el vault no está cargado como directorio adicional, cárgalo:
/add-dir /mnt/c/Users/viite/Documents/OBSIDIAN/VIITEER

### Contexto de negocio
Proyecto de **Mega Energía** (brokerage energético). Buscar en vault:
- Credenciales y configuración API SICOM
- Flujos de consulta CUPS para comerciales
- Tarifas eléctricas y gas (contexto de lo que muestra la herramienta)
- Red de agentes comerciales (usuarios objetivo de esta herramienta)
- Relación con DPC/comparador (comparten lógica CUPS)

### Regla
Antes de tomar decisiones de arquitectura o negocio, consulta el vault para verificar decisiones previas o contexto relevante.

---

## Wiki / Segundo Cerebro

Victor mantiene un wiki persistente (patrón LLM Wiki de Karpathy) en su vault de Obsidian.

- **Ruta:** C:\Users\viite\Documents\OBSIDIAN\VIITEER\_Wiki\
- **Schema:** _Wiki/CLAUDE.md (leer SIEMPRE antes de escribir en el wiki)
- **Páginas:** _Wiki/wiki/{entities,concepts,projects,sources,syntheses,queries,reports}/
- **Index:** _Wiki/index.md (actualizar en cada ingest)
- **Log:** _Wiki/log.md (append-only, entrada en cada operación)
- **Raw (inmutable):** _Wiki/raw/ — NO modificar

Cuando Victor diga "actualiza el wiki", "ingesta al wiki", o "qué sabemos sobre X":
1. Leer C:\Users\viite\Documents\OBSIDIAN\VIITEER\_Wiki\CLAUDE.md
2. Ejecutar la operación (ingest, query, o lint) siguiendo las convenciones
3. Actualizar index.md y log.md

Todo en español. Frontmatter YAML obligatorio en cada página.
