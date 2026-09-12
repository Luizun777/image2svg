# image2svg

Vectorizador raster → SVG 100 % en el navegador que elimina los "picos" (reescalado suave + desenfoque + umbral al 50 % de cobertura antes de trazar) y mide la fidelidad del resultado. Uso personal del usuario; UI en español.

## Stack
- Vite 8 + TypeScript 6 vanilla, vitest 5, Node 26, **npm** (pnpm roto por corepack).
- Motores: `esm-potrace-wasm` (GPL-2.0, principal) y `vtracer-web` (MIT). Proyecto GPL-2.0.
- Deploy: Vercel (image2svg-ashy.vercel.app), que compila con `vercel.json` en la raíz del dominio y se actualiza con cada push a `main`; `.github/workflows/ci.yml` solo verifica (typecheck, tests, build).

## Comandos
- `npm run dev` → http://localhost:5173/image2svg/ (`?synth=circle|line|glyph|flat|sprite|logo|gradient|radial` solo en dev)
- `npm run typecheck` (3 tsconfig: app, worker, tests)
- `npx vitest run <archivo>` — test del archivo tocado; `npm test` completo solo si se pide
- `BENCH=1 npx vitest run tests/bench` — imágenes reales de `samples/` (generar con `scripts/prepare-samples.sh` desde `img/`)
- `npm run build` / `npm run preview`

## Mapa
- `ARCHITECTURE.md` = contrato (firmas, reglas, "Decisiones de implementación"). `PRODUCT.md` y `DESIGN.md` = producto y sistema de diseño (vinculantes).
- `src/core`, `src/svg`, `src/metrics`, `src/tracers`, `src/tuner`: TS puro sobre `{data,width,height}`, sin DOM ni globals de worker, testeable en Node.
- `src/workers/handler.ts` (lógica pura) · `trace.worker.ts` (envoltorio fino) · `client.ts` (latest-wins, recreación tras crash).
- `src/ui` (DOM, contrato estructural `clientContract.ts`), `src/styles`, `src/platform/decode.ts`, `src/dev` (fixtures sintéticos, fuera del bundle de producción).

## Reglas del proyecto
- Cambio en `src/core`/`src/tuner` → validar con el bench además de los tests: los sintéticos no bastan.
- `esm-potrace-wasm` solo se importa en el worker (parchea `TextDecoder`), solo acepta `ImageData`, `extractcolors:false` explícito, y si aborta hay que recrear el worker.
- `vtracer-web`: iniciar con URL explícita del wasm (`?url`), ángulos en radianes, todas las claves de config obligatorias; `filterSpeckle` es área en px² (escalar ×U² como `turdsize`).
- Rasterizar SVG solo en main thread vía `data:` URL; raíz con `width`, `height` y `viewBox`.
- Modo Degradados: el relleno con degradado viaja en `Layer.gradient` (unidades del viewBox; `Layer.fill` queda como color medio de reserva) y se evalúa siempre con `src/core/fillEval.ts` (convención de centro de píxel en `types.ts`); rasterizador, tuner y fixtures no reimplementan `t`. Los tests leen `<defs>` y `url(#…)` (ids `g<h>-<n>`, únicos por documento) con `tests/fixtures/svgBack.ts parseSvg`, no con regex propias. Sin degradados, las salidas de flat, lines y pixel deben quedar byte-idénticas.
- Textos de UI en español y sin em-dashes. `img/` y `samples/` son imágenes reales del usuario: nunca commitear ni publicar.

## Lecciones aprendidas
- Un clamp absoluto del umbral (Otsu en [0.35,0.65]) borraba tinta clara (naranja/cian sobre blanco) y engordaba trazos finos: usar el nivel del 50 % de cobertura (I+P)/2 estimado sobre la luma 1× sin desenfocar.
- Los tests sintéticos pasaban mientras las imágenes reales fallaban (tablero de ajedrez pintado, colores de acento pequeños eliminados): probar siempre en navegador con `samples/` antes de dar por cerrada una fase.
- "Borde duro" debe detectar transiciones abruptas entre cualquier par de colores, no solo blanco/negro, o el pixel art a tamaño nativo se traza con curvas.
- Los workflows pueden morir por límite de sesión a mitad de revisión y dejar `tests/_review_*.test.ts`: al reanudar, comprobar y borrar antes de nada.
- Muchas imágenes "PNG" descargadas son JPEG con un tablero de ajedrez pintado (transparencia falsa). Se detecta en `src/core/bakedBackground.ts`; el tamaño de celda puede ser fraccionario si la imagen se re-muestreó, y un detector de solo borde confunde rayas y cuadros vichy.
- Filtrar colores por población elimina acentos pequeños reales (peces naranjas al 0,4 %) y contornos finos: la regla de supervivencia es espacial (píxeles núcleo o pieza conexa grande y color distinto), no un porcentaje.
