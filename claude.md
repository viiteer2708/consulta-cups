\# CLAUDE.md - Consulta CUPS Mega Energía



\## Descripción

Herramienta web para comerciales de energía.

Consulta información de puntos de suministro (electricidad y gas) 

introduciendo un CUPS, conectando vía API SICOM de Mega Energía.



\## Stack Tecnológico

\- HTML5 + CSS3 + JavaScript vanilla

\- Archivo único: index.html (sin frameworks, sin bundler)

\- API REST SICOM (autenticación Bearer token)



\## Estructura

Archivo único: index.html

Todo el código (HTML + CSS + JS) va en ese archivo.

No crear carpetas ni archivos adicionales salvo que se pida explícitamente.



\## API SICOM

\- Base URL prod: https://sicom.megaenergia.es/sicom/api/1.0

\- Auth: POST /auth/token → Bearer token (válido 3600s, cachear en memoria)

\- Endpoints clave: /sips/info, /sips/consumo/anual, /sips/consumo

\- Unidades: si la API devuelve MWh, convertir siempre a kWh (x1000)



\## Prohibiciones

\- No crear archivos adicionales sin pedirlo

\- No usar frameworks ni npm

\- No hacer git push

\- No instalar dependencias (proyecto sin node\_modules)



\## Permitido sin preguntar

\- Editar index.html directamente

\- Leer y modificar cualquier parte del código

