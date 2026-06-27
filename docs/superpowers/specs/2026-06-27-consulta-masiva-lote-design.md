# Diseño: Consulta masiva de CUPS (modo Lote)

**Fecha:** 2026-06-27
**Proyecto:** consulta-cups (Mega Energía)
**Estado:** Aprobado el diseño; pendiente de plan de implementación.

## 1. Objetivo

Permitir que un comercial / administrador de fincas procese **muchos CUPS de una vez**
y obtenga un **inventario / auditoría completa** de la cartera, **exportable a CSV**.
El lote extrae **solo datos crudos de SICOM** (no ejecuta el optimizador de potencias).

## 2. Decisiones tomadas (brainstorming 2026-06-27)

| Decisión | Elección |
|----------|----------|
| Objetivo del output | Inventario / auditoría completa exportable |
| Escala | Variable, sin límite duro; control de ritmo + barra de progreso + reintentos |
| Entrada | Pegar (textarea, incl. desde Excel) **y** subir archivo CSV/TXT |
| Detalle por CUPS | Solo datos crudos de SICOM (sin optimizador, sin €) |
| Luz / gas | Ambos, **separados**: el usuario elige el tipo del lote; columnas distintas según tipo |
| Procesamiento | En el cliente, contra el proxy actual (no endpoint batch en servidor) |
| Export | CSV con separador `;` + BOM UTF-8 (sin dependencias) |
| UI | Modo `Individual | Lote` (toggle que cambia toda la pantalla) |

### Decisiones técnicas forzadas por las reglas del proyecto
- **Procesamiento en cliente, no en servidor.** El proxy serverless de Vercel tiene
  timeout (~10 s) y un endpoint que procese N CUPS reventaría con lotes grandes; además
  crearía un endpoint nuevo, contra la regla single-file. El navegador llama al proxy
  actual CUPS a CUPS con un pool de concurrencia. **`api/proxy.js` no se toca.**
- **Export CSV (no XLSX).** Un `.xlsx` real necesitaría una librería → choca con
  "no npm". CSV con `;` + BOM se abre directo en Excel español (columnas separadas, acentos OK).

### Defaults asumidos (aprobados implícitamente; revisar)
- **Columnas:** el set completo de la sección 6, tal cual.
- **Concurrencia:** 4 peticiones simultáneas.
- **CSV:** incluye una **fila de cabecera en español** con los nombres de columna.

## 3. Arquitectura general

Todo dentro de [index.html](../../../index.html), en el mismo IIFE, **reutilizando** los
helpers existentes: `safeGet`, `fmt`, `wToKw`, `mwhToKwh`, `getTarifa`, `TARIFAS`,
`getPicosMaximos`, `escapeHtml`, `fmtDate`. La consulta individual actual queda intacta,
solo envuelta en un selector de modo. El optimizador no se usa en lote.

## 4. Componentes (funciones nuevas en el IIFE)

- **`parseLoteInput(texto) -> { cabeceras, items }`**
  Parsea pegado o CSV. Detecta separador (tab de Excel / `,` / `;` / salto de línea).
  Toma la **1ª columna como CUPS** y el resto como columnas extra (dirección, nombre…).
  Si la 1ª fila no parece un CUPS, la trata como cabeceras. Normaliza CUPS (mayúsculas,
  sin espacios), valida con la regex del proxy (`/^ES\d{16,20}\w{0,4}$/i`) y deduplica.
  Devuelve los `items` con `{ cups, extra: {...}, estado }` y las `cabeceras` de los extras.

- **`procesarLote(items, tipo) -> Promise<filas[]>`**
  Pool de concurrencia (**4 a la vez**) sobre el proxy actual.
  - Luz: 3 llamadas (`sips/info` + `sips/consumo/anual` + `sips/consumo`).
  - Gas: 2 llamadas (`sips/info` + `sips/consumo/anual`).
  **Reintento 1×** en fallo de red. Cancelable mediante flag. Emite progreso
  (procesados/total, nº de errores) tras cada CUPS.

- **`extraerFilaElec(info, consumo, max, item) -> fila`** / **`extraerFilaGas(info, consumo, item)`**
  Arman la fila de datos crudos por CUPS (ver columnas en §6). Reutilizan los helpers
  de conversión y formato. Fijan `estado` (`OK` / `Sin datos`).

- **`renderLoteTabla(filas, tipo)`**
  Pinta la tabla en pantalla (columnas clave + estado por color). Filas con error/sin
  datos resaltadas.

- **`exportarCSV(filas, tipo, cabecerasExtra)`**
  Genera CSV con `;` + BOM UTF-8 y fila de cabecera en español. Descarga vía `Blob` +
  `<a download>`. Nombre: `inventario-{luz|gas}-AAAA-MM-DD.csv`. Escapa comillas/`;`/saltos
  por celda.

## 5. Flujo de datos

```
texto/CSV
  -> parseLoteInput            (cabeceras + items validados)
  -> procesarLote(items, tipo) (pool -> proxy actual, con progreso y reintentos)
       -> extraerFilaElec / extraerFilaGas   (por cada CUPS)
  -> filas[]
  -> renderLoteTabla(filas, tipo)  +  botón Exportar CSV -> exportarCSV(...)
```

## 6. Columnas del inventario (datos crudos)

**Luz:**
CUPS · [extras del usuario] · Estado · Tarifa de acceso · Distribuidora · Tensión (V) ·
CNAE · Potencia contratada P1–P6 (kW) · Potencia máxima BIE (kW) · Consumo anual total (kWh) ·
Consumo anual P1–P6 (kWh) · Pico máximo demandado P1–P6 (kW, últimos 12 m) · Última lectura.

**Gas:**
CUPS · [extras] · Estado · Tarifa / Peaje · Distribuidora · Caudal máximo diario ·
Caudal horario · Presión · Código postal · CNAE · Consumo anual (kWh) · Última lectura.

En pantalla se muestran las columnas clave; el **CSV lleva todas**.
Conversiones: potencias W→kW; consumo MWh→kWh cuando `data.unidad` lo indique (regla de oro).

> **A verificar con datos reales:** unidades exactas de los campos de gas
> (`caudalMaximoDiarioEnWhDia`, `caudalHorarioEnWh`): comprobar si vienen en Wh o kWh
> antes de etiquetar la columna. No convertir a ciegas.

## 7. Manejo de errores (el lote nunca se detiene)

Estado por fila:
- `Formato inválido` — no pasa la regex; **no se llama a la API**.
- `Sin datos` — la API responde vacío para ese CUPS y tipo.
- `Error API (código)` — fallo tras el reintento.
- `OK` — datos extraídos.

Al final se muestra el resumen **N OK · M sin datos · K errores**.
Botón **Cancelar** detiene el pool y conserva lo ya procesado (también exportable).

## 8. Ritmo / escala

- Concurrencia 4. Barra de progreso `procesados/total (errores)`.
- Aviso si el lote supera ~200 CUPS ("hará muchas llamadas, puede tardar").
- Sin pausa entre tandas al inicio; si la API devolviera `429`, añadir backoff.

## 9. Verificación (criterio de éxito — cierra el gap Karpathy)

Procesar un lote de prueba: **2–3 CUPS reales conocidos + 1 inválido**, y confirmar:
1. La barra de progreso llega a 100%.
2. Las filas traen los mismos datos que la consulta individual de esos CUPS.
3. El CSV abre en Excel español con columnas separadas y acentos correctos.
4. La fila del CUPS inválido aparece marcada como `Formato inválido` sin llamar a la API.
5. Probar también un lote de gas (2 llamadas/CUPS) y verificar sus columnas.

## 10. Lo que NO se toca

`api/proxy.js`, la consulta individual, el optimizador de potencias, los precios BOE.
Cero dependencias nuevas: sigue siendo single-file vanilla.

## 11. Coste estimado

~250–350 líneas nuevas dentro de `index.html` (HTML del modo + CSS mínimo + JS del lote).
