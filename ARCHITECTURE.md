# image2svg — arquitectura y contratos de módulos

Objetivo: vectorizar imágenes raster a SVG sin "picos" (dientes de sierra) en los trazos, con
medición de fidelidad. Todo corre en el navegador. Ver el plan completo en el historial; este
documento fija **los contratos** entre módulos para que se puedan implementar en paralelo.

## Reglas globales

- `src/core`, `src/svg`, `src/metrics`, `src/tracers`, `src/tuner`, `src/dev`: **TypeScript puro**.
  Prohibido: `document`, `window`, `self`, `OffscreenCanvas`, `Image`, `ImageData` (salvo el
  adapter de potrace, que construye `new ImageData` porque la librería lo exige; en Node hay shim).
- Tipos compartidos: `src/types.ts` (ya escrito; no modificar sin avisar — cambio avisado: `SourceInfo` ganó
  `paletteColors`, `offPaletteRatio`, `quantError` y `twoToneOffRatio`, ver classify; `WarningCode` ganó
  `'empty-trace'`, ver pipeline; transparencia falsa: `SourceInfo` ganó `bakedBackground`, `TraceParams` y
  `ResolvedParams` ganaron `bakedBackground: 'auto' | 'keep'`, `WarningCode` ganó `'baked-checkerboard'` y hay un tipo
  `BakedCheckerboard`, ver bakedBackground; modo Degradados (2026-09-11): `Mode` ganó `'gradient'`, tipos nuevos `GradientStop`,
  `LinearGradient`, `RadialGradient`, `Gradient`, `SolidFill`, `Fill`, `RegionMap`, `Segmentation`, `RegionModel` y `GradientProbe`,
  `Layer` ganó `gradient?`, `SourceInfo` ganó `gradientProbe`, `TraceParams` y `ResolvedParams` ganaron `regionDetail`, `maxStops` y
  `radialGradients`, `WarningCode` ganó `'gradient-fallback'`; ver fillEval, regions, fillModel y "Degradados, fase 0"; la revisión de hallazgos
  solo corrigió los comentarios de `Segmentation.core`, `GradientProbe.explained` y `SourceInfo.gradientProbe`, ver "Degradados, revisión de
  hallazgos"). Importar como
  `import type { … } from '../types'`.
- Imágenes: `RasterImage` (RGBA `Uint8ClampedArray`), `GrayImage` (`Float32Array` 0..255),
  `BinaryMask` (`Uint8Array` 0/1, **1 = tinta**), `LabelMap`.
- Coordenadas de paths (`AbsPath`/`Seg`): absolutas, y hacia abajo, origen arriba-izquierda,
  en píxeles del espacio en que se trazó (reescalado). Números en `number`, sin redondeo hasta serializar.
- Coordenadas de rellenos (modo Degradados; única implementación: `src/core/fillEval.ts`, que usan el ajuste, el refinado de
  etiquetas, el rasterizador y el emisor SVG): continuas, el píxel (x, y) cubre [x, x+1) × [y, y+1) y su centro es (x + 0.5, y + 0.5).
  Un relleno ajustado a 1× está en unidades 1×; el píxel U× (X, Y) tiene su centro en ((X + 0.5)/U, (Y + 0.5)/U) en unidades 1×, así
  que un relleno 1× se emite en unidades del viewBox multiplicando sus coordenadas y `r` por U, sin desplazamiento (`scaleFill`).
  `Layer.gradient` y `PreparedLayer.gradient` van en unidades del viewBox, como los paths. Semántica SVG 1.1 con
  `gradientUnits="userSpaceOnUse"` y `spreadMethod` pad: t lineal = proyección sobre (x2 − x1, y2 − y1) / |d|², radial =
  distancia al centro / r, recortado a [0, 1]; interpolación sRGB entre paradas; |d| = 0 o r = 0 pintan la última parada.
- Determinismo: nada de `Math.random()` sin seed. Los tests usan imágenes sintéticas generadas
  por `src/dev/synth.ts`.
- Estilo: ESM, `verbatimModuleSyntax` (usar `import type`), sin `any` salvo interop wasm,
  funciones puras exportadas con nombre, sin clases salvo donde se indique. Comentarios breves
  en inglés o español, da igual, pero los mensajes de usuario (`Warning.message`) en español.
- Tests: vitest, `tests/**/*.test.ts`, `npm test`. Cada módulo lleva sus tests. Umbrales numéricos
  concretos, no "no lanza".
- Node ≥ 26. `npm run typecheck` debe pasar (tsconfig.json + tsconfig.worker.json +
  tsconfig.tests.json, que typechequea `tests/**` con `types: ['vite/client','node']`).
- Bench sobre imágenes reales (`samples/*.png`, decodificadas con `pngjs`): `BENCH=1 npx vitest run tests/bench`
  (saltado sin `BENCH=1`).

## Módulos y firmas

### src/core/raster.ts
```ts
export function createRaster(width: number, height: number, fill?: [r,g,b,a]): RasterImage
export function cloneRaster(img: RasterImage): RasterImage
export function toGray(img: RasterImage): GrayImage            // luma 0.299R+0.587G+0.114B, ignora alpha
export function alphaToGray(img: RasterImage): GrayImage       // 255 - alpha? NO: devuelve alpha tal cual (0..255); el llamador decide polaridad
export function compositeOnColor(img: RasterImage, bg: RGB): RasterImage   // out = src*a + bg*(1-a), alpha=255; NO muta
export function borderModeColor(img: RasterImage): RGB | null  // moda (5-bit) del anillo de 1 px si >= 80 % coincide (solo píxeles con alpha>=128)
export function alphaStats(img: RasterImage): { transparentRatio: number; partialAlphaRatio: number }
export function dominantInkColor(img: RasterImage, bg: RGB | null): RGB   // color más frecuente (5-bit → promedio real) entre píxeles opacos que difieran del fondo (dist > 48)
```

### src/core/upscale.ts
```ts
export function chooseUpscale(width: number, height: number, requested: UpscaleSetting): { U: number; capped: boolean }
// auto: 4 si min(w,h) <= 512; 2 si <= 1024; si no el mayor U>=1 con w*U*h*U <= 16e6. Con U explícito, reducir si supera 16 Mpx (capped=true).
export function upscaleGray(img: GrayImage, U: number): GrayImage      // U=1 → copia. Bicúbico separable Catmull-Rom (a = -0.5), bordes clamp; cada muestra se recorta (por canal) al [min,max] de sus 2×2 taps más cercanos → sin overshoot (clamp final a [0,255]). Memoria: anillo de 4 filas intermedias, no dstW×srcH×canales.
export function upscaleRaster(img: RasterImage, U: number): RasterImage // mismo filtro por canal, alpha incluido
export function downscaleBox(img: GrayImage, factor: number): GrayImage  // promedio de bloques factor×factor (para proxy del tuner y comparación 2×→1×)
export function downscaleBoxRaster(img: RasterImage, factor: number): RasterImage
```

### src/core/blur.ts
```ts
export function gaussianBlur(img: GrayImage, sigmaPx: number): GrayImage  // separable exacto, radio ceil(3σ), bordes replicados; σ<=0 → copia. Kernel normalizado (suma 1 ± 1e-6). Memoria: anillo de min(2r+1, h) filas, no w×h×canales.
export function gaussianBlurRaster(img: RasterImage, sigmaPx: number): RasterImage
```

### src/core/threshold.ts
```ts
export function histogram256(img: GrayImage): Float64Array        // 256 bins, valores redondeados y clamp
export function otsu(hist: Float64Array): number                   // umbral 0..255 (píxel < t → tinta)
export function resolveThreshold(img: GrayImage, offset: number, invert?: boolean): number
// iso-nivel del 50 % de cobertura: Otsu solo separa dos clases; P = mediana de la clase papel, I = percentil 5 de la clase
// tinta desde su extremo (tinta = clase oscura; la clara con invert); (I+P)/2/255 + offset, clamp [0.02, 0.98].
// Sin separación útil (clase vacía o |P−I| < 24 niveles): clamp(otsu/255, 0.35, 0.65) + offset. Medir sobre el gris SIN
// reescalar ni desenfocar (el desenfoque aclara el núcleo de los trazos finos). Normalizado 0..1
export function binarize(img: GrayImage, thresholdNorm: number, invert?: boolean): BinaryMask // tinta = gray < t*255 (o >= si invert)
export function maskFromAlpha(img: RasterImage, thresholdNorm?: number): BinaryMask // tinta = alpha >= t*255 (default 0.5)
export function isBimodal(hist: Float64Array): boolean             // 2 clusters claros: varianza entre clases de Otsu / varianza total >= 0.6
```

### src/core/morphology.ts
```ts
export function erode1(mask: BinaryMask): BinaryMask   // 4-vecinos, borde = 0
export function dilate1(mask: BinaryMask): BinaryMask
export function countInk(mask: BinaryMask): number
```

### src/core/edges.ts
```ts
export function sobelMagnitude(img: GrayImage): GrayImage
export function hardEdgeRatio(img: GrayImage | RasterImage): number
// entre píxeles con |Sobel| > 64 (en RGB, el mayor de los 3 canales): fracción sin ningún píxel de MEZCLA AA en su 3×3.
// Mezcla q: en SU 3×3 y sobre el canal de mayor rango (> 24), valor a > 12 del mínimo y del máximo y (RGB) color a ≤ 12
// (cada canal) del punto del segmento entre los píxeles del mínimo y del máximo con el mismo t. Un escalón duro entre dos
// niveles cualesquiera es duro; un tercer color real en una esquina de pixel art no está en ese segmento y no cuenta.
export function thinStrokeRatio(mask: BinaryMask): number // 1 - countInk(erode1(mask)) / countInk(mask); 0 si no hay tinta
export function detectGrid(img: RasterImage): number      // mayor k en [8,7,6,5,4,3,2] tal que w%k==0, h%k==0 y TODOS los bloques k×k son de color constante (RGBA exacto); 1 si ninguno
// ---- modo Degradados (fase 1) ----
export interface EdgeMaps { sobel: GrayImage; laplacian: GrayImage }
export function rgbEdgeMaps(img: RasterImage, withAlpha = false): EdgeMaps
// Por canal R, G y B (y alpha con withAlpha; si no, alpha ignorado), bordes replicados, y máximo de los canales: sobel = sqrt(gx² + gy²) con
// cada componente ÷4 (escalón 0→255 = 255, como sobelMagnitude); laplacian = |convolución con [[1,1,1],[1,−8,1],[1,1,1]]| ÷ 8 (0 en un
// degradado lineal, pico en un borde AA). Mismo tamaño que img.
export function hysteresis(mag: Float32Array, width: number, height: number, lo: number, hi: number): BinaryMask
// 1 = mag > hi, o mag > lo y 8-conectado (a través de píxeles > lo) a alguno > hi. Pila Int32Array, sin recursión.
export interface EdgeThresholds { lapHi: number; lapLo: number; sobHi: number; sobLo: number }
export function edgeThresholds(sigma: number, regionDetail: number): EdgeThresholds
// lapHi = max(6, 1.8·4σ) / regionDetail; lapLo = 0.45·lapHi; sobHi = max(24, 9σ) / regionDetail; sobLo = 0.4·sobHi
// (σ = immerkaerSigma). Máscara de bordes = hysteresis(laplacian, lapLo, lapHi) ∪ hysteresis(gateSobel(sobel, laplacian), sobLo, sobHi).
export const SOBEL_GATE_RADIUS = 1, SOBEL_CONTRAST_RADIUS = 2, SOBEL_SEED_CLEARANCE = 3
export function gateSobel(sobel: Float32Array, laplacian: Float32Array, width: number, height: number, t: EdgeThresholds,
  lapRadius = SOBEL_GATE_RADIUS, contrastRadius = SOBEL_CONTRAST_RADIUS): Float32Array
// Revisión de hallazgos. Copia los píxeles ≤ sobLo y los > sobHi. Un píxel débil (sobLo < v ≤ sobHi): si v − (mínimo del Sobel a ≤ contrastRadius
// px, Chebyshev) > sobLo (un escalón localizado) → +Infinity (semilla) cuando ningún píxel fuerte (Sobel > sobHi o laplaciano > lapHi) está a
// ≤ SOBEL_SEED_CLEARANCE px, o v si lo hay; si no, v cuando algún laplaciano > lapLo a ≤ lapRadius px (un pliegue o los lóbulos de un escalón);
// si no, 0 (una rampa: mismo Sobel alrededor y laplaciano 0, ni siembra ni continúa la histéresis). Array nuevo; no muta.
```

### src/core/noise.ts (modo Degradados, fase 1)
```ts
export function immerkaerSigma(img: RasterImage): number
// σ̂ del ruido en niveles 0..255 (Immerkær 1996) sobre la luma 0.299R + 0.587G + 0.114B SIN desenfocar:
// σ = sqrt(π/2) · Σ|L ∗ N| / (6·n), N = [[1,−2,1],[−2,4,−2],[1,−2,1]], sumando solo píxeles interiores cuyo 3×3 es opaco (alpha ≥ 250)
// y lejos de bordes fuertes: se excluye el píxel si algún píxel de su 3×3 tiene Sobel de luma (÷4, bordes replicados) > T =
// max(EDGE_SOBEL_MIN 24, EDGE_SOBEL_PER_SIGMA 3 · σ_all), con σ_all la misma estimación sin exclusión (constantes privadas); n = píxeles
// sumados. Si la exclusión no deja ningún píxel devuelve σ_all; 0 si no hay ningún interior con 3×3 opaco (imágenes < 3×3 incluidas).
// Medido SIN exclusión de bordes (fase 0): limpios hueRamp 0.000, noisePhoto(256) 0.201, diagonalSweep 0.410, flatShapes3 0.480,
// gradientFeathers 0.979, radialDisc 1.069; con withNoise(±3), semillas 1..3: gris plano y hueRamp 1.345..1.360, gradientFeathers
// 1.710..1.720, flatShapes3 1.766..1.806. Ruido entero ±3 independiente por canal = σ 2 por canal y 0.669·2 = 1.337 en luma: sobre
// contenido plano un estimador correcto da ≈ 1.34, por debajo del rango [1.4, 2.1] que el plan pide para "ruido ±3" (ver Decisiones).
```

### src/core/background.ts
```ts
export function resolveBackground(img: RasterImage, setting: BackgroundSetting, info: Pick<SourceInfo,'borderColor'>): RGB | null // null = transparente
export function resolveAlphaMode(info: Pick<SourceInfo,'transparentRatio'>, setting: AlphaMode): 'mask' | 'composite' // auto: 'mask' si transparentRatio > 0.05
```

### src/core/bakedBackground.ts (transparencia falsa: tablero de ajedrez pintado en los píxeles)
```ts
export function detectBakedCheckerboard(img: RasterImage): BakedCheckerboard | null
// { cell, offsetX, offsetY, levels: [RGB, RGB], borderMatchRatio }. Solo imágenes (casi) opacas (<= 1 % con alpha < 248).
// Banda de borde de 3 px (anillo + margen de 2): >= 50 % de sus píxeles neutros (spread <= 12) a +-8 de luma de dos niveles
// claros (>= 128) separados >= 8, cada nivel >= 20 % de los candidatos. Celda cuadrada 6..48 px (fraccionaria) y offsets por
// coherencia de fase de las transiciones de nivel de la banda; gana el periodo cuya paridad explica >= 90 % de los candidatos.
// Paridad de un píxel: (floor((x + 0.5 - offsetX) / cell) + floor((y + 0.5 - offsetY) / cell)) mod 2; levels[p] = color de esa paridad.
// Además las celdas de los dos anillos exteriores deben comportarse como tablero (borderCellsAgree: paridad de sus píxeles
// >= 95 % y mismas medianas en las dos clases de celdas de cada paridad); rayas a 45° y vichy gris no se detectan.
export function bakedBackgroundMask(img: RasterImage, det: BakedCheckerboard): BinaryMask   // 1 = fondo (ver Decisiones); las formas claras que tocan el tablero se reconstruyen enteras
export function applyBakedBackground(img: RasterImage, det: BakedCheckerboard): RasterImage // fondo RGBA 0; franja AA con alpha estimado solo si la mezcla tablero-tinta explica el píxel (residuo <= 32)
export function effectiveSource(img: RasterImage, info: Pick<SourceInfo,'bakedBackground'>, params: { bakedBackground?: 'auto' | 'keep' }): RasterImage
// img tal cual salvo que el análisis aplicara un tablero y params no pida 'keep'. Worker y tuner la usan como original de las métricas.
```

### src/core/params.ts
```ts
export const DEFAULTS: Record<ConcreteMode, Required<Omit<TraceParams,'vtracer'|'mode'>> & { vtracer: VtracerParams }>
export const VTRACER_DEFAULTS: VtracerParams  // 60, 4, 10, 45, 4, 6, 16, 3
export function resolveParams(params: TraceParams, source: { width: number; height: number }, modeIfAuto?: ConcreteMode): ResolvedParams
// mode 'auto' sin modeIfAuto → 'lines'. Clamps: alphamax [0,1.334], opttolerance [0.01,1], turdsize [0,100], blurK [0,1], thresholdOffset [-0.25,0.25], colors [2,32]. pixel: upscale 1, sigmaPx 0.
// Degradados: regionDetail [0.5,2] (defecto 1), maxStops [2,8] entero (defecto 8), radialGradients true solo si es true (defecto true);
// DEFAULTS.gradient = { ...base, layering: 'cutout' }. Los tres campos están en todos los modos (ModeDefaults los exige; PARAM_KEYS de la UI los recoge).
```

### src/core/palette.ts
```ts
export function quantizedHistogram(img: RasterImage, bg: RGB | null): Map<number, { count: number; sum: [number,number,number] }> // clave 5-bit (r>>3<<10|g>>3<<5|b>>3); ignora alpha<128 si bg null
export function distinctColorCount(img: RasterImage, minRatio?: number): number   // colores 5-bit con población >= minRatio (default 0.0005)
export interface ExactPaletteResult { colors: RGB[]; counts: number[]; total: number }
export function exactPaletteDetailed(img: RasterImage, maxColors?: number, minCoreRatio?: number): ExactPaletteResult | null
// Candidatos = bins 5-bit con >= 0.05 %, por población desc. Un candidato a < 12 (RGB crudo) de un dominante se une a él;
// a < 12 del segmento entre dos dominantes (0<t<1) es mezcla AA y se EXCLUYE si >= 60 % de sus píxeles son de RAMPA (su
// color está entre dos vecinos opuestos —horizontal, vertical o diagonal— que difieren >= 24: a < 12 de ese segmento y a
// >= 4 de ambos extremos); solo cerca de los extremos (t fuera de 0.15..0.85) se excluye también si es raro (< 5 % del
// extremo menor) o es una BANDA (>= 50 % de sus píxeles tocan un borde: vecino 4-conexo con Δ canal > 32 — halos JPEG
// de texto fino); el resto (regiones: grandes o contiguas) es un nuevo dominante. null en cuanto aparece el dominante nº maxColors+1 (cuenta DESPUÉS de
// excluir AA). Tras acumular los bins reales: fusiona clusters a distancia ponderada < 20 (MERGE_DISTANCE), descarta
// clusters sin coherencia espacial (MIN_CORE_PIXELS: menos de max(12 px, minCoreRatio = 0.02 % de los contados) píxeles
// núcleo, o núcleo < 5 % de sus píxeles; el mayor siempre sobrevive; ratio <= 0 desactiva la regla; salvo rasgos distintos:
// mayor pieza 8-conexa >= max(12 px, 50 % de sus píxeles) y centro a >= DISTINCT_DISTANCE = 60 de todo cluster coherente) contando sus píxeles
// para el más cercano sin mover su color, y devuelve promedios reales + poblaciones, por población desc. Candidatos: bins
// con >= 0.05 % Y >= 12 px.
export function exactPalette(img: RasterImage, maxColors?: number): RGB[] | null // exactPaletteDetailed(...).colors; [] sin píxeles opacos
export function medianCut(img: RasterImage, k: number): RGB[]
export function kmeansRefine(img: RasterImage, palette: RGB[], iters?: number, sample?: number): RGB[] // distancia ponderada (0.5054, 0.9925, 0.4342)·Δ; muestreo determinista (stride), 10 iters, 20 000 px
export function consolidatePalette(img: RasterImage, palette: RGB[], sample?: number, mergeDistance?: number, minRatio?: number): RGB[] // re-centra, fusiona el par más cercano si dist ponderada < 20, si no descarta el cluster menos coherente de los que no llegan al núcleo mínimo (misma regla y misma excepción de rasgo distinto, sobre la imagen entera; minRatio por defecto 0.02 %); itera hasta estabilizar; por población desc
export function paletteError(img: RasterImage, palette: RGB[], sample?: number): number   // media de la distancia ponderada (0..~305) de los píxeles opacos a su color más cercano
export function offPaletteRatio(img: RasterImage, palette: RGB[], tol?: number, sample?: number): number // fracción de píxeles opacos a > tol (24, RGB crudo) de todo color de la paleta
export function buildPalette(img: RasterImage, colors: number | 'auto', exact: boolean): RGB[] // exact: exactPalette si existe y cabe; si no medianCut(k)+kmeansRefine+consolidatePalette (puede devolver < k colores)
export function assignLabels(img: RasterImage, palette: RGB[]): LabelMap   // nearest (ponderado); alpha<128 → índice del color de fondo si existe, si no 0
export function colorDistance2(a: RGB, b: RGB): number
export function toHex(c: RGB): string  // '#rrggbb' minúsculas
```

### src/core/stack.ts
```ts
export function layerOrder(labels: LabelMap): number[]       // índices de paleta por área desc (fondo primero); estable
export function nestedMasks(labels: LabelMap, order: number[]): BinaryMask[] // masks[j] = píxeles cuyo rank >= j (rank = posición en order). masks[0] = todo. Invariante: masks[j+1] ⊆ masks[j]
export function cutoutMasks(labels: LabelMap, order: number[]): BinaryMask[] // rank == j, luego dilate1
```

### src/core/pixelExact.ts
```ts
export interface Rect { x: number; y: number; w: number; h: number; color: number /* RGBA packed r<<24|g<<16|b<<8|a, unsigned via >>> 0 */ }
export function downscaleNearest(img: RasterImage, k: number): RasterImage   // toma el píxel (0,0) de cada bloque; tamaño ceil(w/k)×ceil(h/k): conserva los bloques parciales del borde
export function mergeRects(img: RasterImage): Rect[]     // greedy: derecha, luego abajo; alpha 0 se omite; orden (y,x)
export function rectsToPathsByColor(rects: Rect[]): Array<{ fill: string; opacity?: number; d: string }> // d relativo: `m dx dy h w v h h -w z`, sin espacios innecesarios; agrupa por color; orden de aparición
export const MAX_PIXEL_RECTS = 200_000
export function countMergedRects(img: RasterImage): number  // lo que devolvería mergeRects().length, sin crear rects
export function pixelSvg(img: RasterImage, k: number, maxRects?: number, size?: { width: number; height: number }): { svg: string; rectCount: number }
// <svg xmlns width height viewBox shape-rendering="crispEdges"> + paths; width/height = size (tamaño de la fuente, por defecto W*k×H*k). Rejilla exacta:
// viewBox="0 0 W H" (una unidad por bloque). Si k no divide la fuente: viewBox="0 0 width height" en píxeles FUENTE, rects escalados por k y
// recortados a la imagen; size debe contener exactamente W y H bloques ((W−1)·k < width <= W·k, igual en alto; si no, RangeError).
// Con > maxRects (default MAX_PIXEL_RECTS, contados antes) → { svg: '', rectCount } sin serializar
```

### src/core/fillEval.ts (modo Degradados; convención de coordenadas en "Reglas globales")
```ts
export const DEGENERATE_EPS = 1e-6
export const DEGENERATE_COLOR_SPAN = 1
export function gradientT(g: Gradient, x: number, y: number): number
// lineal ((x−x1)(x2−x1) + (y−y1)(y2−y1)) / |d|²; radial hypot(x−cx, y−cy) / r; recortado a [0, 1] (pad). |d| = 0 o r ≤ 0 → 1; NaN → 0.
export function stopColorAt(stops: readonly GradientStop[], t: number, out: RGB): RGB
// paradas no decrecientes; interpolación lineal sRGB entre offset_i ≤ t < offset_i+1; t ≤ primer offset → primer color; t ≥ último →
// último color; con varias paradas en un offset, en ese t gana la posterior. Sin paradas → negro. Escribe y devuelve `out`.
export function evaluateFill(f: Fill, x: number, y: number, out: RGB): RGB   // solid → su color; degradado → stopColorAt(stops, gradientT(g, x, y))
export function scaleGradient(g: Gradient, s: number): Gradient              // sobrecargas Linear→Linear, Radial→Radial; coordenadas y r × s, paradas copiadas
export function scaleFill(f: Fill, s: number): Fill                          // solid → copia
export function gradientMeanColor(g: Gradient): RGB
// ∫ de 0 a 1 de la interpolación de paradas (extremos constantes y trapecios), sin redondear: rampa 0→255 = 127.5. Layer.fill = su hex.
export function isDegenerateGradient(g: Gradient): boolean
// < 2 paradas, geometría no finita, |d| < DEGENERATE_EPS, r < DEGENERATE_EPS, o todas las paradas a ≤ DEGENERATE_COLOR_SPAN nivel en
// cada canal → se trata como relleno plano (solid del color medio).
export function normalizeStops(stops: readonly GradientStop[]): GradientStop[]
// offsets recortados a [0, 1] (no finito → 0) y subidos a no decrecientes; colores recortados a [0, 255] (no finito → 0, sin redondear:
// el hex del SVG redondea, ≤ 0.5 niveles); dos paradas en el mismo offset se conservan (parada dura: stopColorAt y SVG saltan del primer color
// al segundo); de tres o más en un offset quedan la primera y la última (las de en medio nunca se ven). Objetos nuevos; no muta.
```

### src/core/regions.ts (modo Degradados, fase 2)
```ts
export const MAX_GRADIENT_REGIONS = 2000
export const PREBLUR_SIGMA = 0.7      // gaussianBlurRaster antes de los mapas de bordes
export const CORE_MIN_ALPHA = 128     // píxel núcleo: alpha ≥ 128 y no borde (con transparencia el alfa entra en los mapas de bordes)
export const REGION_MIN_ALPHA = 128   // por debajo, región −1 (el mismo corte que el centinela transparente de flat)
export const BAND_RINGS = 3           // anillos de growIntoBand (segmentRegions ya no la usa, ver Decisiones)
export const NO_REGION = 0xffff       // etiqueta U× (Uint16Array) sin región
export const ORPHAN_STEP_RATIO = 2, ORPHAN_RAY_LENGTH = 8, ORPHAN_MIN_AREA = 16, THIN_BLEND_RATIO = 0.5   // revisión de hallazgos
export interface SegmentEdges { edge: BinaryMask; edgeShare: number; sigma: number; thresholds: EdgeThresholds }
export function segmentEdges(img: RasterImage, opts: { regionDetail: number; sigma?: number }): SegmentEdges
// La etapa de bordes de segmentRegions: sigma = opts.sigma ?? immerkaerSigma(img); preblur PREBLUR_SIGMA (premultiplicado, y con el canal alfa
// en rgbEdgeMaps, si hay alpha < 255) → edgeThresholds(sigma, regionDetail) → hysteresis(laplacian) ∪ hysteresis(gateSobel(sobel, laplacian));
// edgeShare = |edge ∧ alpha ≥ 128| / |alpha ≥ 128|. El pipeline decide aquí el fallback por bordes, antes de etiquetar.
export function segmentRegions(img: RasterImage, opts: { regionDetail: number; sigma?: number; edges?: SegmentEdges }): Segmentation
// edges = opts.edges ?? segmentEdges(img, opts) (del mismo tamaño) → core = alpha ≥ CORE_MIN_ALPHA ∧ ¬edge → labelComponents(core) → los píxeles con
// alpha ≥ REGION_MIN_ALPHA sin región se rellenan POR COLOR (growByColour, privada: crecimiento con semillas sobre el RGB sin desenfocar,
// prioridad |ΔR| + |ΔG| + |ΔB| con el 4-vecino etiquetado, cola de 766 cubetas FIFO por prioridad; el píxel toma el 4-vecino etiquetado de
// color más parecido, empate → id menor; origin[p] = el píxel core del que partió su crecimiento) → huérfanos: un píxel crecido (no core) con
// max canal |p − origin[p]| > ORPHAN_STEP_RATIO·sobHi cuyos 8 rayos (ORPHAN_RAY_LENGTH px, cortados por transparencia o el borde de la imagen)
// encuentran algún píxel core y ningún par de colores de esos primeros píxeles core (un píxel consigo mismo incluido) deja un segmento a
// ≤ ORPHAN_STEP_RATIO·sobHi de su color (un trazo no es mezcla de lo que lo rodea; un píxel AA entre dos regiones sí); los grupos 4-conexos
// de huérfanos de ≥ ORPHAN_MIN_AREA px salen de su región y forman regiones nuevas (ids a continuación), los menores se quedan → los que no
// alcanza ninguna región forman componentes 4-conexas nuevas (ids a continuación) → núcleo fino de las regiones nuevas (huérfanas y
// sobrantes, sin núcleo por la máscara de bordes): sus píxeles que no son mezcla de sus dos vecinos elegibles en x ni en y (a ≤
// THIN_BLEND_RATIO·sobHi del segmento entre ellos y a más de eso de ambos); una región donde todos lo son los toma todos → area y
// regionAdjacency. No usa growIntoBand ni BAND_RINGS (medido en Decisiones, fases 1 y 2). Invariantes: regions.data[i] = −1 ⇔ alpha < 128;
// todo píxel core tiene región; toda región tiene algún píxel core; edgeShare = el de edges; sigma = el usado.
export function labelComponents(mask: BinaryMask): RegionMap
// componentes 4-conexas de mask = 1 (union-find Int32Array); ids 0..count−1 en orden de su primer píxel en raster; −1 fuera de mask.
export function growIntoBand(regions: RegionMap, eligible: BinaryMask, rings: number): RegionMap
// No muta. En cada anillo, cada píxel eligible sin región con algún 4-vecino etiquetado (antes de ese anillo) toma la etiqueta más frecuente
// entre sus 8 vecinos etiquetados (empate → id menor). Tras `rings` anillos, los eligible que sigan sin región forman componentes 4-conexas
// nuevas (ids a continuación); count actualizado.
export function regionAdjacency(regions: RegionMap): Int32Array[]  // [i] = ids 4-adyacentes a i, ascendentes, sin i ni repetidos
export function mergeRegions(seg: Segmentation, pairs: ReadonlyArray<readonly [number, number]>): { seg: Segmentation; remap: Int32Array }
// Aplica los pares [src, dst] en orden (union-find: [a,b],[b,c] → a y b en c). Ids nuevos compactos 0..count'−1 en orden del menor id
// original de cada grupo; remap[idViejo] = idNuevo. regions, area y adjacency recalculados; edge, core, sigma y edgeShare iguales. No muta.
export function regionOrder(seg: Segmentation): number[]
// Orden pintor (atrás → delante), permutación de 0..count−1: área descendente (empate: id menor); después, toda región cuya adyacencia
// es exactamente [a] y que no toca el borde de la imagen se pinta después de a (anillo alrededor de un disco: el disco después; un fondo que
// solo toca un anillo no se mueve), cadenas resueltas; en un ciclo (dos regiones que solo se tocan entre sí, aisladas por transparencia) la
// primera por área conserva su sitio.
export function refineLabels(seg: Segmentation, fills: readonly Fill[], up: RasterImage, U: number): Uint16Array
// Etiquetas de `up` (up.width × up.height). U = píxeles de up por píxel de seg (U·f si se segmentó en un proxy de factor f); fills[k] =
// relleno de la región k en unidades de seg. Píxel (X, Y) con alpha de up < 128 → NO_REGION. Si no, (x, y) = (floor(X/U), floor(Y/U))
// recortado al tamaño de seg: si su 3×3 en seg tiene una sola etiqueta ≥ 0, esa; con > 1, la k de ese 3×3 que minimiza
// Σ_c (evaluateFill(fills[k], (X + 0.5)/U, (Y + 0.5)/U)_c − up_c)² (empate → la del píxel (x, y), después el id menor); sin ninguna → NO_REGION.
export function rankMap(labels: Uint16Array, order: readonly number[]): Uint16Array
// In place: etiqueta k → posición de k en order; NO_REGION se queda. Devuelve el mismo array.
export function regionMask(ranks: Uint16Array, width: number, height: number, j: number, layering: Layering, dilate: number): BinaryMask
// cutout: rank === j dilatada `dilate` veces con dilate1 (el pipeline pasa ceil(U/2)) ∧ rank ≥ j: la dilatación queda debajo de las capas
// posteriores y nunca encima de las anteriores (fase 6, Decisiones); stacked: rank ≥ j. En ambos, ∧ rank ≠ NO_REGION.
```

### src/core/fillModel.ts (modo Degradados, fase 3; no importa regions.ts)
```ts
// Coordenadas: centro de píxel (x + 0.5, y + 0.5) en la resolución de img/seg (convención de "Reglas globales").
export const MOMENTS_PER_REGION = 16
// Momentos de la región k en m[16·k + i], sobre sus píxeles core (seg.core = 1 y región k), x e y = centros:
export const M_N = 0, M_X = 1, M_Y = 2, M_XX = 3, M_XY = 4, M_YY = 5, M_R = 6, M_G = 7, M_B = 8,
  M_RX = 9, M_GX = 10, M_BX = 11, M_RY = 12, M_GY = 13, M_BY = 14, M_CC = 15   // M_CC = Σ (R² + G² + B²)
// Constantes exportadas (cifras en Decisiones, fase 3): MIN_MODEL_CORE 64; FLAT_RMSE_FLOOR 2, FLAT_RMSE_SIGMA 1.5; GRADIENT_RMSE_FLOOR 2.5,
// GRADIENT_RMSE_SIGMA 2, GRADIENT_MAX_FLAT_RATIO 0.6; RADIAL_MAX_LINEAR_RATIO 0.85; STOP_EPS_FLOOR 1.5, STOP_EPS_SIGMA 0.8; RAMP_TRIM 0.005;
// BIN_LENGTH 4, MIN_BINS 8, MAX_BINS 64; IRLS_PASSES 2, TUKEY_C 4.685, MAD_TO_SIGMA 1.4826, TUKEY_MIN_SCALE 1; RADIAL_SMOOTH_SIGMA 0.7,
// RADIAL_MAX_SAMPLES 8192, RADIAL_MIN_SAMPLES 16, RADIAL_MIN_GRADIENT 0.05, RADIAL_MIN_CONDITION 0.05, RADIAL_MIN_RADIUS 2,
// RADIAL_MONOTONE_EPS_FACTOR 2; MERGE_MIN_AREA_FLOOR 16, MERGE_MIN_AREA_SHARE 2e-5, MERGE_MAX_RMSE_GAIN 1.5, MERGE_MAX_BOUNDARY_JUMP 3,
// MERGE_MAX_AXIS_DEG 15, MERGE_MAX_JOINT_PIXELS 32768, MERGE_MAX_BOUNDARY_SAMPLES 4096; MICRO_PER_BIN 16, PRUNE_MAX_RMSE_LOSS 0.05;
// FLAT_END_TOL_FACTOR 2, MERGE_SMALL_MAX_OFFSET 24 (revisión de hallazgos); SPLIT_KMEANS_ITERATIONS 12, SPLIT_MAX_RMSE_RATIO 0.8,
// SPLIT_MIN_RMSE_GAIN 1.5, SPLIT_MAX_DEPTH 2 (división de regiones complejas).
export function accumulateMoments(img: RasterImage, seg: Segmentation): Float64Array   // longitud 16·count; una pasada
export interface RegionPixels { offsets: Int32Array; indices: Int32Array }
export function corePixels(seg: Segmentation): RegionPixels
// CSR: píxeles core de la región k = indices[offsets[k] .. offsets[k+1]) (y·W + x, en raster); offsets de longitud count + 1.
export interface FitOptions { sigma: number; maxStops: number }
export function fitFlat(m: Float64Array, id: number): { color: RGB; rmse: number }
// media por canal; rmse = sqrt(max(0, M_CC − Σ_c S_c² / n) / (3n)) (pooled sobre R, G, B); n = 0 → [0, 0, 0] y 0.
export interface Plane { cx: number; cy: number; mean: RGB; gx: RGB; gy: RGB; rmse: number }
export function fitPlane(m: Float64Array, id: number): Plane
// c(x, y) ≈ mean_c + gx_c·(x − cx) + gy_c·(y − cy), (cx, cy) = centroide del núcleo; mínimos cuadrados 2×2 centrados por canal;
// determinante ≈ 0 (núcleo colineal) → gx = gy = 0; rmse pooled del plano.
export function planeAxis(p: Plane): { ux: number; uy: number; strength: number; collinearity: number }
// autovector principal unitario de Σ_c g_c g_cᵀ con g_c = (gx_c, gy_c), sin ponderar por luma (rampas solo de tono); strength = sqrt(λ1)
// (niveles/px); collinearity = λ2/λ1 (0 si λ1 = 0); signo fijo: ux > 0, o ux = 0 y uy > 0.
export function fitLinear(img: RasterImage, px: RegionPixels, id: number, plane: Plane, opts: FitOptions): { fill: LinearGradient; rmse: number } | null
// eje = planeAxis(plane); t = proyección de los centros core; extremos p0.5 / p99.5 → (x1, y1) y (x2, y2) sobre la recta por el centroide;
// L = longitud; K = clamp(round(L/4), 8, 64) bins → vértice por bin (parámetro y color medios ponderados) → Douglas–Peucker ε = max(1.5,
// 0.8σ) (distancia RMS sobre R, G, B) → ≤ maxStops nudos, recolocados sobre MICRO_PER_BIN micro-bins por bin y podados mientras el RMSE
// ponderado suba ≤ PRUNE_MAX_RMSE_LOSS → colores de parada = mínimos cuadrados ponderados de la rampa a trozos sobre los píxeles; IRLS Tukey
// 2 pasadas. Extremos planos: mientras queden más de 2 paradas y la primera (o la última) esté a ≤ FLAT_END_TOL_FACTOR·ε niveles por canal de
// su vecina, se quita y (x1, y1) o (x2, y2) pasa a la parada que queda (el pad ya pinta ese color), con los offsets reescalados a [0, 1].
// rmse = el de la RAMPA de paradas (evaluateFill) sobre el núcleo, no el del plano. null si strength = 0 o L < 1 px.
export function fitRadial(img: RasterImage, px: RegionPixels, id: number, opts: FitOptions & { support?: (pixel: number) => boolean }): { fill: RadialGradient; rmse: number } | null
// centro = intersección por mínimos cuadrados de las rectas que siguen el gradiente de color de cada píxel core; r = p99.5 de ρ; bins sobre
// ρ como fitLinear; null si el sistema es singular, r < 2 px o la rampa no es monótona. opts.support(p) dice si el píxel p (y·W + x) es de la
// región para los soportes 9×9 / 3×3 de las derivadas (por defecto: estar en la lista de px); planMerges lo pasa cuando la lista es una muestra
// por paso. Extremos planos como fitLinear: un centro plano deja su primera parada con offset > 0 (el centro no se mueve) y un borde plano
// acerca r a la última parada que queda.
export function selectModel(img: RasterImage, px: RegionPixels, id: number, moments: Float64Array, opts: FitOptions & { radial: boolean; support?: (pixel: number) => boolean }): RegionModel
// Escalera: núcleo < 64 px → solid; rmseFlat ≤ max(2, 1.5σ) → solid; lineal aceptable si rmseLin ≤ max(2.5, 2σ) y ≤ 0.6·rmseFlat; radial
// aceptable (solo con opts.radial) si rmseRad ≤ max(2.5, 2σ), ≤ 0.6·rmseFlat y ≤ 0.85·rmseLin (o sin lineal); gana el radial aceptable, si
// no el lineal aceptable; si ninguno → complex = true con el candidato de menor rmse. isDegenerateGradient → solid. fill en unidades de img
// con normalizeStops; rmse del fill elegido; rmseFlat; coreCount = núcleo.
export function rmseOf(img: RasterImage, px: RegionPixels, id: number, fill: Fill): number   // RMSE pooled de evaluateFill sobre el núcleo de id
export interface MergeOptions { sigma: number; minArea: number; maxRmseGain: number; maxBoundaryJump: number; pixels?: RegionPixels; maxStops?: number; radial?: boolean; smallGroups?: boolean }
export function planMerges(img: RasterImage, seg: Segmentation, models: readonly RegionModel[], opts?: Partial<MergeOptions>): Array<[number, number]>
// Pares [src, dst] (src se funde en dst), en orden de aplicación (union-find); el pipeline los aplica con regions.mergeRegions y re-ajusta
// las fusionadas. 1) diminutas (area < minArea, defecto max(16, 2e-5·W·H)) y regiones sin núcleo, de menor a mayor área, al 4-vecino con
//    mayor frontera común / (1 + rmseOf de su modelo sobre el núcleo de la diminuta y de lo que ya absorbió) (sin núcleo: la mayor frontera);
//    un vecino sin núcleo solo como último recurso; 2) compatibles, voraz por menor coste rmseJoint − max(rmse_A, rmse_B): nunca dos lineales
//    con ejes a más de MERGE_MAX_AXIS_DEG; salto = media sobre la frontera de la mayor diferencia por canal entre los dos modelos extrapolados
//    linealmente (sin pad) al punto medio de cada par ≤ maxBoundaryJump (defecto 3 niveles); selectModel sobre A ∪ B (≤ 32 768 píxeles y
//    ≤ 4096 pares, por paso uniforme; con paso > 1 fitRadial lee sus soportes de seg.core y las regiones de A y B) con rmse ≤ max(rmse_A,
//    rmse_B) + maxRmseGain (defecto 1.5); si uno de los grupos tiene menos de MIN_MODEL_CORE píxeles de núcleo (sólido por la escalera, no por
//    sus colores) y el salto falla, se admite igualmente cuando el modelo del otro grupo, extrapolado sin pad, falla su núcleo por RMSE
//    ≤ MERGE_SMALL_MAX_OFFSET (prueba barata antes del ajuste conjunto) y el modelo conjunto también explica ese núcleo con RMSE
//    ≤ max(rmse_A, rmse_B) + maxRmseGain (una punta de pluma cortada por un borde espurio; solo con opts.smallGroups, defecto true; el sondeo
//    del clasificador lo desactiva); destino = la de mayor área (empate: id menor) y el
//    grupo toma el modelo conjunto. src ≠ dst. opts.pixels debe ser corePixels(seg); opts.maxStops y opts.radial (defectos 8 y true) para los
//    ajustes conjuntos.
export function extendGradient(img: RasterImage, fill: Gradient, pixels: Int32Array): Gradient
// Revisión de hallazgos. u = parámetro del degradado en cada píxel de `pixels` (lineal: proyección / |d|²; radial: ρ / r) y sus cuantiles
// RAMP_TRIM uLo, uHi: un lineal con uLo < 0 o uHi > 1 lleva sus extremos a esos cuantiles y un radial con uHi > 1 pasa a r·uHi (el centro
// queda), con los offsets reescalados y la primera y la última parada movidas hacia fuera sobre sus segmentos (color extrapolado y recortado a
// [0, 255]); mismo número de paradas. Se devuelve solo si su RMSE sobre `pixels` es menor; si no, el mismo objeto.
export function splitComplex(img: RasterImage, px: RegionPixels, id: number, opts: FitOptions & { radial?: boolean; fill?: Fill; maxDepth?: number }): { assign: Uint8Array; fills: Fill[] } | null
// Parte una región que ningún relleno explica (complex) en 2..2^maxDepth partes con su propio relleno; cifras en Decisiones, "Degradados,
// división de regiones complejas". Un nivel = k-means determinista con k = 2 sobre (x, y, residuo de luma CON SIGNO del relleno actual), los
// tres rasgos escalados a [0, 1] (x e y por la caja de la región, el residuo por su rango) para que geometría y error de color pesen igual,
// sembrado en los píxeles de residuo máximo y mínimo (empate: el índice menor), con ≤ SPLIT_KMEANS_ITERATIONS pasadas y parada en cuanto
// ningún píxel cambia de grupo (empate de distancia: el primer grupo); luego selectModel en cada parte, que puede salir sólida, lineal o
// radial. El nivel se acepta solo si las dos partes tienen ≥ MIN_MODEL_CORE píxeles de núcleo Y el RMSE ponderado por núcleo de las dos baja
// a ≤ SPLIT_MAX_RMSE_RATIO del de la región Y al menos SPLIT_MIN_RMSE_GAIN niveles por debajo; si no, esa rama se queda entera. Una parte que
// la escalera sigue llamando complex se parte otra vez, hasta maxDepth niveles (defecto SPLIT_MAX_DEPTH). null si no se partió nada.
// px = los píxeles de núcleo (corePixels, o el núcleo de ajuste del pipeline); opts.fill = el mejor relleno actual de la región (sin él lo
// ajusta). assign[i] = la parte del i-ésimo píxel de núcleo de id, en el orden de px; fills[p] = el relleno de la parte p. Los píxeles de la
// región que NO son núcleo (la banda) no están en px: los reparte quien llama (el pipeline, a la parte que mejor los predice).
```

### src/core/classify.ts
```ts
export function analyzeSource(img: RasterImage, bakedBackground?: 'auto' | 'keep'): SourceInfo // usa raster/edges/palette/threshold
// 'auto' (defecto): detectBakedCheckerboard primero; con detección, todas las estadísticas miden applyBakedBackground(img) y
// bakedBackground = la detección. 'keep': mide los píxeles tal cual y bakedBackground = null.
export function offPaletteShare(info): number // offPaletteRatio * (1 - transparentRatio)
// SourceInfo añade: paletteColors (nº de colores reales de exactPaletteDetailed, null si > 32), offPaletteRatio
// (fracción de píxeles opacos a > 24 de esa paleta; con null, de una paleta medianCut(8)+kmeans), quantError (error medio ponderado)
// y twoToneOffRatio (fracción a > 48 de una paleta medianCut(2)+kmeans). hardEdgeRatio se mide sobre el RGB compuesto sobre el fondo.
export function classify(info: SourceInfo): ClassifyResult
// pixel si grid>=2 || (hardEdgeRatio>0.9 && min(w,h)<=128 && w*h<=1 Mpx)   [el nº de colores ya no interviene]
// lines si (paletteColors<=2 && offPaletteRatio<=0.5) || (paletteColors===null && isBimodal && twoToneOffRatio<=0.5)
//   [con fondo transparente (transparentRatio > 0.05): paletteColors<=1 y sin la regla de escaneo ruidoso]
//   [isBimodal solo NO basta: GENTERA tiene 6 colores planos con luma bimodal; Instagram y eagle son degradados de color con luma bimodal]
// photo (flat, colors=16, exactPalette=false + warning 'photo') si paletteColors===null || offPaletteShare(info) > 0.15
// flat (colors 'auto') en otro caso
// warning 'thin-strokes' si thinStrokeRatio > 0.5 en modo lines
// ---- modo Degradados (fase 7; cifras en Decisiones, "Degradados, fase 7") ----
export const GRADIENT_PROBE_MAX_SIDE = 512, GRADIENT_PROBE_MAX_STOPS = 4, GRADIENT_PROBE_MIN_COLORS = 8
export const GRADIENT_MAX_EDGE_SHARE = 0.6, GRADIENT_MAX_REGIONS = 400, GRADIENT_MIN_EXPLAINED = 0.85
export const GRADIENT_FLAT_MIN_GRADIENT_SHARE = 0.05, GRADIENT_SUGGEST_EXPLAINED = 0.5
export const GRADIENT_MAX_COMPLEX_SHARE = 0.5, GRADIENT_PROBE_FOREIGN_RATIO = 2, GRADIENT_PROBE_INTERIOR_RADIUS = 2   // revisión de hallazgos
export function gradientProbeFactor(width: number, height: number): number   // max(1, ceil(max(w, h) / GRADIENT_PROBE_MAX_SIDE))
export function probeGradients(img: RasterImage, background?: RGB | null): GradientProbe
// background: null = transparente (sin componer; el proxy se reduce sobre color premultiplicado, como el pipeline), RGB = se compone
// encima; omitido = el de resolveBackground 'auto' (borderModeColor). Proxy (downscaleBoxRaster, f = gradientProbeFactor) → sigma =
// immerkaerSigma(proxy) → seg = segmentRegions(proxy, { regionDetail: 1, sigma }). Si seg.edgeShare > GRADIENT_MAX_EDGE_SHARE o las regiones
// crudas > MAX_GRADIENT_REGIONS (donde el modo Degradados cae a la paleta plana): { sigma, regions: crudas, explained: 0, linearShare: 0,
// radialShare: 0, edgeShare } sin ajustar nada. Si no: accumulateMoments → selectModel por región (GRADIENT_PROBE_MAX_STOPS paradas,
// radial) → UNA ronda de planMerges → mergeRegions → selectModel de las regiones que agrupan más de una (las demás conservan su modelo).
// Fracciones del área etiquetada (píxeles del proxy con alpha ≥ 128): explained = regiones con rmse ≤ max(GRADIENT_RMSE_FLOOR,
// GRADIENT_RMSE_SIGMA·sigma) (la cota de aceptación lineal de fillModel) menos sus píxeles ajenos: los que están a ≥ GRADIENT_PROBE_INTERIOR_RADIUS
// px (Chebyshev) de cualquier otra etiqueta o transparencia y a más de GRADIENT_PROBE_FOREIGN_RATIO·sobHi niveles (máximo por canal) del modelo
// de su región (una forma que la segmentación entregó a su vecina; el rmse de núcleo no los ve); linearShare / radialShare = regiones pintadas
// con lineal / radial (complex incluidas). Si las regiones complex superan GRADIENT_MAX_COMPLEX_SHARE del área (donde el pipeline cae a la
// paleta plana), con los modelos del primer ajuste (sin planMerges) o tras la ronda de fusiones: explained, linearShare y radialShare = 0.
// 0×0 → todo 0. No muta.
// analyzeSource: gradientProbe = (exact === null || offPaletteShare > PHOTO_OFF_PALETTE_RATIO || paletteColors ≥ GRADIENT_PROBE_MIN_COLORS)
//   ? probeGradients(fuente efectiva, transparentRatio > 0.05 ? null : borderColor ?? blanco) : null
//   [el plan decía solo la rama foto: el pájaro, radialDisc y diagonalSweep tienen paleta exacta de 19 / 9 / 9 colores; ver Decisiones]
export function choosesGradient(probe: GradientProbe, flatPalette: boolean): boolean
// edgeShare ≤ GRADIENT_MAX_EDGE_SHARE && regions ≤ GRADIENT_MAX_REGIONS && explained ≥ GRADIENT_MIN_EXPLAINED
// && (!flatPalette || linearShare + radialShare ≥ GRADIENT_FLAT_MIN_GRADIENT_SHARE); flatPalette = paletteColors !== null && offPaletteShare ≤ 0.15.
// classify: tras pixel y lines y ANTES de la regla flat: probe && choosesGradient(probe, flatPalette) → 'gradient' (params { mode: 'gradient' },
// sin avisos) con el motivo "El N % de los píxeles se explica con M regiones de color plano o degradado (el K % con degradados): se vectoriza
// en modo Degradados." (sin el paréntesis si K < 0.5 %; "1 región") y, en la rama flat, "Sus C colores planos cubren la imagen, pero partirían
// cada degradado en bandas de color."; si no, flat o photo como antes, y el aviso 'photo' termina en " Prueba el modo Degradados." cuando
// probe.explained ≥ GRADIENT_SUGGEST_EXPLAINED.
```

### src/core/pipeline.ts (integración; se escribe después de los demás)
```ts
export interface PreparedLayer { mask: BinaryMask | (() => BinaryMask); fill: string; opacity?: number; gradient?: Gradient }
// mask perezosa: una función que construye la máscara al leerla (modo Degradados: una sola máscara U× viva a la vez); gradient en unidades
// del viewBox (U×); fill '#rrggbb' (con gradient, el color medio de sus paradas).
export function layerMask(pl: PreparedLayer): BinaryMask            // llama a la función en CADA lectura: quien la necesite dos veces la guarda
export function isFullMask(mask: BinaryMask): boolean
export function rectPath(w: number, h: number): AbsPath             // [0,w]×[0,h] en unidades del viewBox
export async function traceLayers(prepared: Prepared, tracer: Tracer, opts: TracerOptions): Promise<Layer[]>
// Compartida por trace() y el tuner (la copia de autotune.ts se borró): una Layer por PreparedLayer con paths; máscara llena → rectPath(W·U,
// H·U) sin trazar; copia opacity (< 1) y gradient.
export const GRADIENT_PROXY_AREA = 4e6            // segmentación y ajuste en un proxy de ≤ 4 Mpx
export const GRADIENT_MAX_EDGE_SHARE = 0.6        // Segmentation.edgeShare por encima → fallback
export const GRADIENT_MERGE_ROUNDS = 3            // rondas de planMerges → mergeRegions → reajuste
export const GRADIENT_FIT_DEPTH = 1               // banda profunda: píxeles con alpha ≥ 250 cuyo 3×3 es de su región (núcleo o borde)
export const GRADIENT_FIT_MIN_CORE_SHARE = 0.5    // núcleo < 0.5·|núcleo ∪ banda profunda| → se ajusta también sobre la unión
export const GRADIENT_FIT_CORE_TOLERANCE = 0.5    // la unión gana si no se vuelve compleja y su RMSE sobre el núcleo ≤ el del núcleo + 0.5
export const GRADIENT_MAX_COMPLEX_SHARE = 0.5     // regiones complex por encima de esta fracción del área etiquetada → fallback (revisión)
export const GRADIENT_SPLIT_SMOOTH_PASSES = 4     // pasadas de mayoría sobre las etiquetas de las partes de una región dividida (división)
export const GRADIENT_SPLIT_MIN_ISLAND = MIN_MODEL_CORE   // 64: trozo 4-conexo más pequeño que el split deja de una parte (px del proxy); por debajo se absorbe
export const GRADIENT_SPLIT_MAX_NEW_SHARE = 0.25  // presupuesto: el split añade ≤ max(2^SPLIT_MAX_DEPTH − 1, ceil(0.25·regiones)) regiones a la imagen
export function gradientProxyFactor(width: number, height: number): number   // f = max(1, ceil(sqrt(W·H / GRADIENT_PROXY_AREA)))
export type GradientFit =
  | { kind: 'fallback'; reason: string }          // reason en español, minúscula inicial, sin punto final
  | { kind: 'regions'; base: RasterImage; transparent: boolean; f: number; sigma: number; seg: Segmentation; models: RegionModel[]; rawRegions: number; mergeRounds: number; splitRegions: number }
// seg y models en unidades del proxy (seg.core = núcleo de ajuste: núcleo ∪ banda profunda de las regiones ajustadas sobre ella); base = fuente
// compuesta sobre el fondo resuelto (la fuente misma si es transparente). No depende de U, desenfoque ni capas: el tuner lo memoiza.
export function fitGradientRegions(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): GradientFit
export interface FittedRegions { fitSeg: Segmentation; px: RegionPixels; models: RegionModel[]; deep: Uint8Array }   // deep[k] = 1: ajustada sobre núcleo ∪ banda profunda
export function splitComplexRegions(proxy: RasterImage, seg: Segmentation, fitted: FittedRegions, fitOpts: { sigma: number; maxStops: number; radial: boolean }): { fitted: FittedRegions; splitRegions: number } | null
// La llama fitGradientRegions con el ajuste ya hecho; exportada solo para los tests, que le pasan segmentaciones hechas a mano (un núcleo
// verdadero mucho más disperso que el de ajuste, y un k-means que deja islas): ninguna muestra llega sola a esos dos casos.
export function prepareGradient(img: RasterImage, resolved: ResolvedParams, info: SourceInfo, fit?: GradientFit): Prepared   // fit = fitGradientRegions(img, resolved, info)
export function prepareForMode(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): Prepared   // lines/flat/gradient; pixel lanza. trace() y el tuner la usan
export function gradientFallbackWarning(reason: string | null): Warning
// 'gradient-fallback': "No se pudieron reconstruir los degradados[: <reason>]. Se vectorizó como Color plano con 16 colores y pueden verse bandas de color."
export interface Prepared { U: number; width: number; height: number; layers: PreparedLayer[]; warnings: Warning[] }
export function prepareLines(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): Prepared
export function prepareFlat(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): Prepared
export async function trace(img: RasterImage, params: TraceParams, tracers: Record<Engine, Tracer>, info?: SourceInfo): Promise<TraceResult>
// lines: composite/mask → gray → upscale U → blur σ → binarize con resolveThreshold(gray SIN reescalar ni desenfocar, offset, invert)
//        (en modo mask, 0.5+offset) → tracer → Layer → assembleSvg (viewBox W·U H·U, width W, height H).
//        relleno 'auto': en modo mask el color más frecuente de los píxeles opacos (dominantInkColor(img, null)); en composite info.dominantInk.
//        warning 'empty-trace' si la máscara queda sin tinta y la imagen no está en blanco (en blanco = luma compuesta Y alpha uniformes), o si el trazador elimina toda la tinta;
//        en composite con alpha no uniforme el texto remite a "Transparencia: Máscara" en lugar del umbral
// flat:  composite → palette sobre la imagen ORIGINAL compuesta → upscaleRaster U + blurRaster σ (PREMULTIPLICADO si el fondo es
//        transparente) → assignLabels sobre la reescalada+desenfocada → layerOrder → nestedMasks/cutoutMasks → tracer por máscara →
//        capas de atrás hacia delante. Fondo opaco: masks[0] cubre todo el lienzo y se emite como un path rectangular (sin trazar).
//        Fondo transparente (resolveBackground null): los píxeles con alpha<128 reciben la etiqueta centinela `count` → no cuentan
//        para el orden por área, no pertenecen a NINGUNA capa (las máscaras se intersecan con alpha>=0.5) y no hay rect de fondo.
//        Un color al que no se asigna ningún píxel no genera capa.
// gradient: fitGradientRegions: fondo y composición como flat (resolveBackground; transparente → sin componer) → proxy ≤ 4 Mpx
//        (f = gradientProxyFactor, downscaleBoxRaster, premultiplicado con transparencia) → sigma = immerkaerSigma(proxy) →
//        edges = segmentEdges(proxy, { regionDetail, sigma }); si edges.edgeShare > GRADIENT_MAX_EDGE_SHARE: { kind: 'fallback', reason } con
//        "el N % de la imagen es borde", sin etiquetar nada → seg = segmentRegions(proxy, { regionDetail, sigma, edges }); si seg.regions.count
//        (regiones crudas) > MAX_GRADIENT_REGIONS: fallback con "la imagen se divide en N regiones (el límite es 2 000)" → selectModel por región (maxStops, radial = radialGradients) sobre su núcleo y, si el núcleo es
//        < GRADIENT_FIT_MIN_CORE_SHARE de núcleo ∪ banda profunda, también sobre esa unión (gana según GRADIENT_FIT_CORE_TOLERANCE) → hasta
//        GRADIENT_MERGE_ROUNDS rondas de planMerges(proxy, seg con el núcleo de ajuste, models, { sigma, pixels, maxStops, radial }) →
//        mergeRegions → reajuste de las regiones nuevas que agrupan más de una (las demás conservan su modelo). Si las complex superan
//        GRADIENT_MAX_COMPLEX_SHARE del área etiquetada (tras el primer ajuste, sin rondas de fusión, y otra vez tras ellas): fallback con
//        "el N % de la imagen no se explica con colores planos ni degradados" → por debajo de ese límite, las complex que queden se parten
//        (splitComplexRegions): splitComplex sobre el núcleo de ajuste de cada una, por área descendente (id como desempate) y mientras las
//        regiones que añade quepan en el presupuesto GRADIENT_SPLIT_MAX_NEW_SHARE y en MAX_GRADIENT_REGIONS; la parte 0 conserva el id y las
//        demás reciben ids nuevos al final; los píxeles de la región que no son núcleo (la banda) van a la parte cuyo relleno los predice mejor
//        (el criterio de refineLabels); GRADIENT_SPLIT_SMOOTH_PASSES pasadas de mayoría por 8 vecinos dentro de la región alisan las dos
//        fronteras (si una parte quedaría con menos de MIN_MODEL_CORE píxeles del núcleo de ajuste, esa región vuelve a sus etiquetas sin
//        alisar) y absorbIslands absorbe todo trozo 4-conexo de una parte por debajo de GRADIENT_SPLIT_MIN_ISLAND px que toque un trozo mayor de
//        otra parte de la misma región; última puerta, sobre las etiquetas finales: cada parte necesita MIN_MODEL_CORE píxeles del núcleo
//        VERDADERO (el que ajusta fitRegionModels), y si no, esa región no se parte. Se reconstruyen area y regionAdjacency y las partes se
//        ajustan como las regiones de una ronda de fusión (fitRegionModels). Una parte que sigue siendo complex se pinta con su mejor candidato.
//        Por último cada degradado pasa por extendGradient sobre la banda
//        profunda de su región (su rango de paradas llega al contorno y no se queda donde acaba el núcleo) y rmse se recalcula sobre el núcleo.
//        prepareGradient: fallback → prepareFlat(img, { ...resolved, mode: 'flat', colors: 16, exactPalette: false }, info) +
//        gradientFallbackWarning(reason). Si no: up = resampleRaster(base, U, sigmaPx, transparent) → ranks = refineLabels(seg del proxy,
//        rellenos en unidades del proxy, up, U·f) → con f > 1, cada región del proxy sin ningún píxel cuyo 3×3 (dentro de la imagen) sea todo
//        suyo (un trazo de ≤ 2 px en el proxy, promediado con su entorno por la reducción) pasa a sólido del color medio de los píxeles de up que
//        refineLabels le dio, y si alguno cambió se vuelve a llamar a refineLabels con esos rellenos → regionOrder → rankMap → una capa por región
//        con píxeles U×, en ese orden:
//        { mask: () => regionMask(ranks, W·U, H·U, j, layering, cutout ? ceil(U/2) : 0), fill: rgbToHex(color) o gradientMeanHex(g),
//        gradient: degradado no degenerado ? scaleGradient(g, U·f) : ausente }; avisos: upscale-capped y large-input. Las máscaras ya excluyen
//        los píxeles con alpha(up) < 128 (NO_REGION), así que no se intersecan aparte con la máscara alfa. El fondo es una capa más (stacked
//        sobre fondo opaco: máscara llena → rect en traceLayers). Sin <defs> ni gradient cuando todas las regiones son solid (flatShapes3 → 3
//        capas sólidas).
// pixel: detectGrid (o gridScale) → downscaleNearest → pixelSvg(…, tamaño de la fuente): el SVG mide siempre lo que la fuente y un gridScale que no la
//        divide conserva los bloques parciales en píxeles fuente; stats: 3 nodos por rect (m h v h z), cornerFraction 1; warning 'too-many-rects' si > 10 000 rects.
//        > MAX_PIXEL_RECTS (200 000): no se construye el SVG (svg '', stats a 0) y 'too-many-rects' explica el límite y remite a Color plano
// trace(): info = analyzeSource(img) solo si hace falta (auto, lines, flat o gradient; un modo pixel explícito no la calcula); prepara con prepareForMode;
//          mode auto → classify(info) y sus params rellenan los huecos de `params`; motor ausente → fallback + warning 'engine-unavailable';
//          los warnings se deduplican por código; `ms` con performance.now()
```

### src/svg/pathParse.ts
```ts
export function parsePathData(d: string): AbsPath        // M/m L/l H/h V/v C/c S/s Q/q T/t Z/z, coordenadas implícitas repetidas, números con exponente y '.5.5'. Devuelve segmentos absolutos (H/V → L; S/T expandidos a C/Q)
export function applyTransform(p: AbsPath, t: { tx?: number; ty?: number; sx?: number; sy?: number }): AbsPath // x' = x*sx + tx ; y' = y*sy + ty (escala primero, luego traslación, como translate(tx,ty) scale(sx,sy))
export function parseTransform(attr: string): { tx: number; ty: number; sx: number; sy: number }  // solo 'translate(a,b) scale(c,d)' en cualquier orden/ausencia; ignora otros
```

### src/svg/pathSerialize.ts
```ts
export function serializePath(p: AbsPath, precision?: number): string   // absolutas, precision decimales (default 3), sin ceros finales, sin espacios redundantes
export function pathBounds(p: AbsPath): { minX: number; minY: number; maxX: number; maxY: number } // sobre puntos de control
```

### src/svg/pathStats.ts
```ts
export function pathStats(layers: Layer[], svgBytes: number): PathStats
export function countSegments(d: string): { lines: number; curves: number; moves: number } // sobre un string d (útil para tests): L/l/H/h/V/v cuentan como línea (incl. implícitas), C/c/S/s/Q/q/T/t como curva
```

### src/svg/assemble.ts
```ts
export interface AssembleOptions { width: number; height: number; viewBoxWidth: number; viewBoxHeight: number; crispEdges?: boolean; precision?: number; background?: RGB | null }
export function assembleSvg(layers: Layer[], opts: AssembleOptions): string
// <svg xmlns="http://www.w3.org/2000/svg" width="W" height="H" viewBox="0 0 VW VH"> [ <rect fill=bg width=VW height=VH/> si background ] <path fill="#…" [fill-opacity] d="…"/> por capa (una path por capa con todas sus subrutas concatenadas, fill-rule="evenodd" cuando hay >1 subruta) </svg>. Sin XML prolog. Sin saltos de línea innecesarios (una capa por línea está bien).
// Degradados (fase 4): si alguna capa con d no vacío lleva gradient y !isDegenerateGradient(gradient), justo tras '<svg …>' (antes del
// <rect> de fondo) va '\n<defs>' + '\n' + serializeGradient(capa.gradient, id, precision) por cada una de esas capas + '\n</defs>', y esa capa
// escribe fill="url(#id)" en lugar de layer.fill; el resto de atributos y su orden no cambian (fill, fill-opacity, fill-rule, d). Degradado
// degenerado → layer.fill. Sin degradados la salida es byte-idéntica a la actual. Revisión de hallazgos: id = `g${h}-${n}` con n = 0, 1… en
// orden de capas y h = gradientIdPrefix del documento escrito con los ids g0, g1…: estables para las mismas capas y distintos entre documentos
// (dos SVG pegados en una página ya no resuelven url(#g0) al degradado del otro).
export function gradientIdPrefix(s: string): string   // FNV-1a de 32 bits de las unidades UTF-16 de s, en base 36
```

### src/svg/gradients.ts (modo Degradados, fase 4)
```ts
export function serializeGradient(g: Gradient, id: string, precision: number): string
// <linearGradient id="ID" gradientUnits="userSpaceOnUse" x1="…" y1="…" x2="…" y2="…"><stop offset="…" stop-color="#rrggbb"/>…</linearGradient>
// <radialGradient id="ID" gradientUnits="userSpaceOnUse" cx="…" cy="…" r="…"><stop …/>…</radialGradient>
// Coordenadas con formatNumber(v, precision) (la misma precisión que los paths); paradas = normalizeStops(g.stops), offset con
// formatNumber(o, 4) y stop-color = rgbToHex; sin gradientTransform, fx, fy ni spreadMethod (pad por defecto). En una línea.
export function gradientMeanHex(g: Gradient): string   // rgbToHex(gradientMeanColor(g))
```

### src/svg/optimize.ts (solo navegador, import perezoso; puede quedar para la fase de pulido)
```ts
export async function optimizeSvg(svg: string): Promise<string>
```

### src/tracers/types.ts
```ts
export type { Tracer, TracerOptions } from '../types'
export function maskToRaster(mask: BinaryMask): RasterImage   // tinta = negro opaco, fondo = blanco opaco
export const TURNPOLICY_CODE: Record<TurnPolicy, number>       // black 0, white 1, left 2, right 3, minority 4, majority 5
```

### src/tracers/svgParse.ts
```ts
export function extractPaths(svg: string): Array<{ d: string; fill: string | null; transform: string | null }> // regex, sin DOM; captura transform del <g> padre si el path no tiene
```

### src/tracers/potrace.ts
```ts
export function createPotraceTracer(): Tracer
// init(): await init() de esm-potrace-wasm una sola vez.
// traceBinary: maskToRaster → new ImageData → potrace(img, {turdsize, turnpolicy: code, alphamax, opticurve: 0|1, opttolerance, pathonly: false, extractcolors: false, posterizelevel: 2, posterizationalgorithm: 0})
//   → extractPaths → parsePathData → applyTransform(parseTransform(transform)) → AbsPath[] en píxeles de la máscara (y hacia abajo).
// Formato real observado (esm-potrace-wasm 0.5.1):
//   <svg … width="16.000000" height="16.000000" viewBox="0 0 16.000000 16.000000" …><g transform="translate(0.000000,16.000000) scale(0.100000,-0.100000)" fill="#000000" stroke="none"><path d="M40 80 l0 -40 40 0 40 0 0 40 0 40 -40 0 -40 0 0 -40z"/></g></svg>
//   Curvas: "M252 509 c-48 -14 -109 -80 -123 -131 -23 -89 12 -182 88 -229 …z" (comandos relativos con repeticiones implícitas).
// Máscara vacía → []. Errores del wasm → throw Error('potrace: …') (nunca dejar el módulo en estado roto sin señalarlo).
```

### src/tracers/vtracer.ts
```ts
export function createVtracerTracer(): Tracer
// init(source?: URL | string | BufferSource): import init, { to_svg } from 'vtracer-web'; await init({ module_or_path: source }). Si no se pasa source en navegador el worker le pasa la URL (`vtracer-web/vtracer.wasm?url`). En Node tests: readFileSync('node_modules/vtracer-web/vtracer.wasm').
// traceBinary: rgba de maskToRaster → to_svg(new Uint8Array(rgba.data.buffer), w, h, { binary: true, mode: 'spline', hierarchical: 'stacked', cornerThreshold: deg→rad, lengthThreshold, maxIterations, spliceThreshold: deg→rad, filterSpeckle, colorPrecision, layerDifference, pathPrecision })
//   → extractPaths (paths llevan transform="translate(x,y)") → parse → applyTransform. Salida real observada:
//   <svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="16" height="16">\n<path d="M0 0 C2.64 0 5.28 0 8 0 … Z " fill="#000000" transform="translate(4,4)"/>\n</svg>
// Nota: vtracer emite C incluso para tramos rectos (control points colineales) — cornerFraction no es comparable entre motores.
export function vtracerColorSvg(img: RasterImage, params: VtracerParams, hierarchical: Layering): string // modo color nativo (binary:false) — devuelve el SVG crudo con viewBox añadido
```

### src/metrics/bbox.ts
```ts
export interface Box { x0: number; y0: number; x1: number; y1: number } // inclusivo-exclusivo
export function inkBBox(gray: GrayImage, bgLuma: number, tol?: number, dilateFrac?: number): Box // píxeles con |v-bg|>tol (24); bbox dilatado 5 % de max(w,h); toda la imagen si no hay tinta
```

### src/metrics/ssim.ts
```ts
export function ssim(a: GrayImage, b: GrayImage, roi?: Box, win?: number): number // ventana 8×8 (imágenes integrales), stride 4, C1=6.5025, C2=58.5225; media sobre ventanas dentro del ROI; ssim(a,a)=1
```

### src/metrics/iou.ts
```ts
export function iou(a: BinaryMask, b: BinaryMask, roi?: Box): number      // 1 si ambas vacías
export function mae(a: GrayImage, b: GrayImage, roi?: Box): number
export function pctDiff(a: RasterImage, b: RasterImage, threshold: number, roi?: Box): number // max canal RGB
```

### src/metrics/diffMap.ts
```ts
export function diffHeatmap(a: RasterImage, b: RasterImage): RasterImage // d = maxΔ/255; alpha = min(255, d*765); color amarillo (d<0.3) → naranja → rojo (d>=0.6); d*255 <= 16 → transparente
```

### src/metrics/scanline.ts
```ts
export function flattenPath(p: AbsPath, tolerance?: number): Array<Array<[number, number]>> // polilíneas cerradas por subruta; cúbicas/cuadráticas subdivididas adaptativamente (tol 0.1 px)
export function rasterizeMask(paths: AbsPath[], width: number, height: number, supersample?: number): GrayImage // cobertura 0..255 nonzero winding, supersample 4 (4×4 subsamples)
export function rasterizeLayers(layers: Layer[], width: number, height: number, background: RGB | null, supersample?: number): RasterImage // compone de atrás hacia delante con la cobertura como alpha
// Degradados (fase 5): capa con gradient no degenerado → color del píxel (x, y) del raster = evaluateFill(gradient, x + 0.5, y + 0.5)
// (unidades del raster = del viewBox), permitido vía LUT de 256 entradas por degradado sobre t (≤ 1 nivel frente a evaluateFill);
// cobertura y composición como hoy. Capa sólida o degradado degenerado → parseFill(layer.fill), sin cambios.
```

### src/metrics/fidelity.ts
```ts
export interface FidelityInput { original: RasterImage; rendered: RasterImage; mode: ConcreteMode; background: RGB; thresholdNorm?: number }
export function computeMetrics(inp: FidelityInput): Metrics
// ambos compuestos sobre background → gray; ROI = inkBBox(originalGray); SSIM y MAE sobre gaussianBlur σ=0.8; IoU sobre máscaras binarizadas SIN desenfocar (lines: umbral thresholdNorm ?? Otsu del original; flat/gradient/pixel: IoU = 1 - pctDiff16); fidelity = 0.6*ssim + 0.4*iou (clamp 0..1)
export function tunerScore(m: Metrics, stats: PathStats, perimeterPx: number): number // m.fidelity - 0.15*stats.cornerFraction - 0.10*min(1, stats.nodeCount / max(1, 2*perimeterPx))
```

### src/dev/synth.ts (fixtures sintéticos, sin binarios)
```ts
export function coverage(size: number, sdf: (x: number, y: number) => number, ss?: number): Float32Array // 0..1 por píxel; ss=8 → 64 submuestras; dentro si sdf<0
export function grayToRaster(cov: Float32Array, size: number, ink: RGB, bg: RGB): RasterImage
export function aaCircle(size?: number, r?: number): { image: RasterImage; maskAt: (U: number) => BinaryMask; area: number; perimeter: number } // 64, 20, negro sobre blanco
export function aaDiagonalLine(size?: number, width?: number, angleDeg?: number): { image: RasterImage; maskAt: (U: number) => BinaryMask }
export function glyph(size?: number): { image: RasterImage; maskAt: (U: number) => BinaryMask } // anillo (r 14/9) ∪ barra horizontal → 1 componente con 1 agujero
export function flatShapes3(size?: number): { image: RasterImage; labels: LabelMap; palette: RGB[] } // fondo #F2E8D5, círculo #2A6F97, rect #E07A5F, bordes AA por mezcla lineal
export function sprite32(seed?: number): RasterImage   // 6 colores + alpha 0, bloques aleatorios 2–6 px, PRNG mulberry32
export function nearestUpscale(img: RasterImage, k: number): RasterImage
export function transparentLogo(size?: number): { image: RasterImage; maskAt: (U: number) => BinaryMask } // RGB constante #1D3557, alpha = cobertura de una estrella de 5 puntas
export function noisePhoto(size?: number, seed?: number): RasterImage  // ruido suave > 200 colores
export function filledSquare(size?: number, inset?: number): RasterImage // 64, 16 → cuadrado negro sobre blanco
export function bakedCheckerLogo(opts?: { size?; cell?; offset?; levels?; noise?; seed?; inner?: 'none' | 'counters' | 'whiteRect' }): { image; background: BinaryMask; coverage: Float32Array; counters: BinaryMask; whiteRect: BinaryMask }
// 128 px, celda 10 (fraccionaria admitida), niveles 255/204, ruido +-4 por canal con semilla; logo magenta #E6007E (disco AA + barra)
// sobre un tablero pintado y opaco. background = cobertura < 0.5; counters: agujeros del disco; whiteRect: rectángulo blanco opaco
export function chessboardGraphic(size?: number, cell?: number, levels?: [number, number], background?: RGB): { image; board: BinaryMask } // tablero 8×8 real sobre fondo sólido
// ---- modo Degradados: patrón { image, verdad }; rellenos en coordenadas 1× continuas (centro de píxel +0.5) ----
export interface GradientShape { sdf: Sdf; fill: Fill; label: number }
export function gradientFeathers(size?: number, seed?: number): { image: RasterImage; shapes: GradientShape[]; labels: RegionMap; background: RGB }
// 256, 1: abanico de 8 plumas (hexágonos romos, ejes a 7° + 22.5°·k) con degradado lineal de 2 paradas de la base (x1, y1) a la punta
// (x2, y2); 3 (#2040d0 → #8030c0) y 4 (#8030c0 → #2040d0) comparten 32 px de lado recto (≥ 33 niveles de diferencia en todo el contacto);
// sombra plana #20222a (disco r 11) sobre 6 y 7, dibujada la última; fondo blanco = etiqueta 0 (solid `background`); labels 0..9 (count 10),
// shapes[k].label = k + 1. Pintado sin conflation (cobertura efectiva por submuestra, cada relleno evaluado en el centro del píxel). La
// semilla solo varía la longitud de las puntas (× 0.94..1). Geometría exacta en el comentario de la función.
export function radialDisc(size?: number): { image: RasterImage; fill: RadialGradient; sdf: Sdf }   // 128: disco (60, 66) r 48; radial #ffe08a@0 → #ff7a3d@0.5 → #7a1fa2@1 con r 48
export function diagonalSweep(size?: number): { image: RasterImage; fill: LinearGradient; sdf: Sdf } // 128: cuadrado [16, 112] con esquinas r 20; (20, 108) → (108, 20): #feda75@0 #fa7e1e@0.3 #d62976@0.65 #962fbf@1
export function hueRamp(size?: number): { image: RasterImage; fill: LinearGradient }               // 96: rampa horizontal #ed2b2b (x = 0) → #149e14 (x = size), luma Rec.601 101.006 constante
export function withNoise(img: RasterImage, amp?: number, seed?: number): RasterImage               // 3, 1: entero uniforme en [−amp, amp] por canal RGB (independientes), alpha intacto
export function encodePng?  // NO: sin dependencias
```

### tests/fixtures/helpers.ts
```ts
export function maskIoU(a: BinaryMask, b: BinaryMask): number
export function assertMaskNested(outer: BinaryMask, inner: BinaryMask): void
export function rasterEquals(a: RasterImage, b: RasterImage): boolean
```

### tests/fixtures/svgBack.ts (leer un SVG del pipeline de vuelta)
```ts
export function parseSvg(svg: string): { width; height; vbW; vbH; layers: Layer[]; paths: AbsPath[] } // extractPaths + parsePathData, una capa por <path>
export function binarise(cov: GrayImage): BinaryMask          // cobertura >= 128
export function renderAt1x(parsed, background: RGB | null): RasterImage // rasterizeLayers al tamaño del viewBox y downscaleBoxRaster(U) (o nearestUpscale en modo pixel)
// Degradados (fase 4): parseSvg lee <defs> (linearGradient / radialGradient con sus stop) y a cada <path fill="url(#id)"> le asigna
// layer.gradient (unidades del viewBox) y layer.fill = gradientMeanHex; renderAt1x los pinta vía rasterizeLayers.
```

### tests/fixtures/gradientCases.ts (casos de la revisión de hallazgos)
```ts
export function paintCases(width, height, background: RGB | null, shapes: PaintedCase[]): RasterImage   // supermuestreo 4×4, color premultiplicado
export function thinBars(): { image; bars: Bar[] }                  // 200×120 blanco, barras (20,20,20) de 2..12 px desde x = 6.3
export function feathersWithBars(), feathersWithRampButton()        // gradientFeathers(256) en 256×320 + 12 barras de 3-5 px / un botón en rampa
export function steepRamp(w): { image; box; colourAt }              // 160×128 blanco, rectángulo en rampa (255·t, 0, 128·(1 − t)) de w px
export function semiTransparentDisc(), gradientRectsWithSemiDisc()  // disco #ff8800 alfa 200 sobre transparencia / con tres rectángulos en rampa
export function lowContrastShapes(delta), lowContrastDisc(delta)    // formas planas #3060c0 + delta dentro de un cuadrado #3060c0
export function splitRadialDisc(): RasterImage                      // radialDisc(512) con la columna x = 240 del disco +60 en G y B
export function fullColumns(bar), fullRows(bar): number[]
```

### Modo Degradados en la UI, métricas y fixtures de desarrollo (esqueleto; controles propios en la fase 8)
```ts
// format.ts: MODE_LABEL.gradient = 'Degradados'; fidelityExplanation('gradient') = la de flat (color píxel a píxel).
// controlSchema.ts: MODES = ['auto', 'lines', 'flat', 'gradient', 'pixel']; 'layering' visible en flat y gradient (en gradient 'cutout' por
//   defecto); colores/paleta exacta solo en flat. Fase 8, solo en gradient: "Detalle de regiones" (regionDetail 0.5–2, paso 0.1, "Menos ↔ Más
//   regiones"), "Paradas máximas" (maxStops 2–8), toggle "Degradados radiales" (radialGradients), nota de Capas "Recortadas por defecto: cada
//   forma con su propio degradado, editable".
// warnings.ts: WARNING_TITLE['gradient-fallback'] = 'Degradados no reconstruidos', acción TO_FLAT ("Cambiar a Color plano"); empty-trace en
//   gradient como en flat ("Quitar manchas mínimas"). Fase 8: el caso 'photo' ofrece "Usar degradados" cuando gradientCandidate. Revisión:
//   mergeWarnings descarta el 'photo' del clasificador en modo gradient (describe la paleta plana de 16 colores y sugiere Degradados).
// metrics/fidelity.ts: gradient se mide como flat. tuner: comparisonBackground trata gradient como flat.
// src/dev/fixtures.ts: SYNTH_FIXTURES + 'gradient' (gradientFeathers(512)) y 'radial' (radialDisc(256)).
```

## Decisiones de implementación

Aclaraciones tomadas al implementar (los módulos las cumplen y los tests las fijan):

- `isBimodal` exige, además de separabilidad de Otsu ≥ 0.6, clases compactas (std de cada clase ≤ 0.25 × distancia entre medias);
  sin eso una rampa uniforme o una sola gaussiana pasaban por bimodal.
- `sobelMagnitude` se normaliza (÷4 por componente) para que un escalón 0→255 dé exactamente 255.
- `resolveBackground` 'auto' = transparente (null) si > 5 % de píxeles con alpha < 8; si no, el color de borde; si no, blanco.
- `chooseUpscale` aplica el tope de 16 Mpx también a 'auto' (capped=true si redujo el candidato).
- `downscaleBox`/`downscaleBoxRaster` aceptan tamaños no múltiplos: los bloques parciales promedian solo los píxeles existentes.
- La barra del fixture `glyph` ocupa x∈[12,24]: llega hasta el centro y deja exactamente un agujero.
- `filterSpeckle` de vtracer-web 0.1.0 es un ÁREA en px² (comprobado: mota de 9 px se conserva con 9 y se elimina con 10);
  el pipeline lo escala por U² igual que turdsize.
- `exactPalette` cuenta los colores DESPUÉS de excluir el AA (cambio respecto a la primera versión, que contaba los bins
  candidatos antes): un logo plano con muchos tonos de suavizado sigue teniendo paleta exacta. Además excluye las
  BANDAS (colores sobre un segmento cuyos píxeles tocan bordes en ≥ 50 %: halos JPEG de texto fino), fusiona clusters a
  distancia ponderada < 20 y descarta clusters < 0.5 % reasignando sus píxeles. Consecuencia conocida: detalles reales
  por debajo del 0.5 % (los peces naranja de clip_art, 0.38 %) se pierden. [Sustituido: el suelo de población es ahora
  la regla de coherencia espacial, ver "Transparencia falsa y coherencia espacial de la paleta".]
- `buildPalette` consolida el resultado de medianCut+kmeans (`consolidatePalette`: fusión < 20 ponderada, descarte < 0.5 %),
  así que puede devolver menos colores de los pedidos.
- `assignLabels` manda alpha<128 al índice de la paleta más cercano al color de borde (si está a < 12), si no al 0.
- `parsePathData` inserta un M implícito tras Z cuando sigue un comando de dibujo; `serializePath` usa repeticiones implícitas.
- Clasificador: `distinctColors` (bins 5-bit con ≥ 0.05 %) ya no decide nada — el ruido JPEG lo infla (clip_art: 75 tonos
  para 3 colores). Decide `paletteColors` (colores reales tras AA) y `offPaletteRatio` (fracción de píxeles a > 24 de la
  paleta). Se descartó el error medio de cuantización como criterio: con la paleta exacta clip_art (ruido JPEG) da 12.2 y
  el degradado de Instagram 9.5, no separa; la fracción fuera de paleta sí (planos/líneas ≤ 0.083, degradados/fotos ≥ 0.29;
  umbral 0.15). `quantError` queda en SourceInfo como dato informativo.
- Regla pixel: `grid ≥ 2 || (hardEdgeRatio > 0.9 && min(w,h) ≤ 128 && w·h ≤ 1 Mpx)`; un dibujo B/N de bordes duros mayor de
  128 px es 'lines'. El tope de área (PIXEL_MAX_AREA) impide que una fuente grande sin cuadrícula acabe en modo píxel.
- Photo: `exactPalette: false` además de `colors: 16` — la paleta exacta es justo la que no cubre la imagen (splash: 4 colores
  que dejan el 39 % fuera); sin ese flag buildPalette la reutilizaba porque 4 ≤ 16.
- Pipeline flat con fondo transparente: reescalado y desenfoque sobre color premultiplicado (el RGB de los píxeles
  transparentes es basura y el filtro bicúbico la mezclaba en el borde), etiqueta centinela para alpha<128 (sin capa),
  sin rect de fondo; la primera capa es tinta real.
- `pixelStats`: 3 nodos por rectángulo (`m dx dy h w v h h -w z` = 3 segmentos), coherente con `pathStats`.
- `computeMetrics` exige un fondo no nulo: pipeline y bench comparan sobre el color de borde o blanco.
- Resultado medido de la prueba anti-picos (potrace, aaCircle 64/20): con upscale 4 + blur 0.35·U el círculo sale con
  cornerFraction 0 e IoU 0.9956 frente a maskAt(4); el trazado ingenuo (U=1, sin blur) también da cornerFraction 0
  (potrace con alphamax 1 ya redondea la escalera de un disco de 40 px) pero pierde IoU (0.9815 con la misma vara de 4×)
  y usa más nodos (6 vs 5; con el umbral de iso-nivel, 6 vs 6: ver abajo). Donde sí se ve en los cortes: glyph 0.333 → 0.190.
  La línea de 1.5 px salía un 27 % más ancha con el Otsu recortado a 0.65; con el iso-nivel sale a su ancho (ver abajo).

- Umbral de líneas = iso-nivel geométrico del 50 % de cobertura (`resolveThreshold`). El recorte absoluto del Otsu a
  [0.35, 0.65] hacía desaparecer la tinta clara: naranja #FFA500, cian #00FFFF, dorado #FFD700 y gris claro #D3D3D3 sobre
  blanco tienen Otsu 215-229 → 166, binarize 0 px de tinta, SVG vacío sin aviso (IoU trazado 0); navy #000080 sobre
  #303030 iba a 0.35 = 89 > 48 → todo tinta (IoU 0.307, tinta ×3.26). Ahora: t = (I + P)/2 con P = mediana de la clase
  papel e I = percentil 5 de la clase tinta; medidos (IoU trazado potrace, U 4, blur 0.35·U, vs máscara ideal 4×):
  naranja 0.9954, cian 0.9956, dorado 0.9954, gris claro 0.9945, navy/#303030 0.9956; aaDiagonalLine(1.5) 0.786 / tinta
  ×1.272 → 0.954 / ×0.995; aaCircle 0.9956 → 0.9945; glyph 0.9732 → 0.9744.
  · Los niveles se miden sobre el gris 1× SIN desenfocar: medidos sobre la imagen reescalada y desenfocada, el mejor
    percentil solo llega a IoU 0.880 en la línea de 1.5 px (el desenfoque aclara su núcleo a ~35 y el nivel sube a 146).
  · Percentil de tinta (1×): p1..p10 dan 0.954 en la línea de 1.5 px, p25 0.938, p50 0.775; en una línea de 1 px p1..p5
    0.912, p10 0.901. p5 además ignora motas aisladas. Con ruido ±10 los resultados no cambian (0.965 en la línea).
  · Fallback (clase vacía o |P−I| < 24 niveles, imagen casi uniforme o puro ruido): el Otsu recortado de antes.
  · noSpikes aaCircle: con t = 127.5 el trazado suavizado usa 6 nodos (IoU 0.9945) y el ingenuo también 6 (IoU 0.9815).
    El nº de nodos de potrace no es monótono en el nivel (5 nodos a t = 130, 6 a 127.5, 10 a 125), así que ese test ya solo
    exige "no más nodos que el ingenuo"; la ventaja de IoU (> 0.01) y cornerFraction siguen fijadas.
- Warning `'empty-trace'` (nuevo `WarningCode`): lines con máscara sin tinta y fuente (gris compuesto o alpha) no uniforme,
  o cuando el trazador elimina toda la tinta de máscaras no vacías (turdsize/filterSpeckle mayor que las formas). Antes el
  SVG salía vacío en silencio. Una imagen uniforme (en blanco) no avisa.
- `hardEdgeRatio` redefinido: "duro" = transición abrupta sin valor AA intermedio entre dos niveles CUALESQUIERA, medido en
  RGB. La regla antigua (toda la vecindad < 16 o > 239) solo reconocía blanco/negro: el pixel art de color nativo daba 0 y
  nunca era 'pixel' (sprite32: hardEdgeRatio 0, 'flat', 128 curvas). Medido con la regla nueva (tol 12): sprite32 semillas
  1-7 sobre blanco 1.000 (→ 'pixel'); dibujo 1 bit 100 px 1.000; aaCircle 0.054; glyph 0.088; aaDiagonalLine 0;
  transparentLogo 0; flatShapes3 0 → 0.576 (el rectángulo está en coordenadas enteras, sin AA: sus bordes SON duros; el test
  que pedía < 0.5 pasa a 0.3..0.8); clip_art 0 → 0.213; avatar Compartamos 0 → 0.042; GENTERA 0.195; Instagram 0.145;
  eagle 0.038; splash 0.102. Descartadas: (a) mirar solo el valor del píxel central frente al min/max de su 3×3 — los
  píxeles puros junto a la banda AA son extremos y cuentan como duros (aaCircle 0.649, flatShapes3 0.847, avatar 0.633);
  (b) exigir que toda la vecindad esté junto al min o el max — las esquinas donde se tocan tres bloques tienen un tercer
  color "intermedio" en algún canal (sprite32 0.83-0.93). La comprobación de colinealidad resuelve (b).
- `exactPalette`: la exclusión AA en el tramo central del segmento (0.15 < t < 0.85) era solo geométrica y tiraba colores
  reales: blanco + disco negro AA (6600 px) + disco gris 128 AA (6362 px) → [blanco, negro]; tres grises planos 192 / 64 / 30
  (cuadrados 24×24 en 96×96) → 2 colores. Ahora la prueba es espacial: mezcla solo si ≥ 60 % de sus píxeles son de rampa
  (entre dos vecinos opuestos distintos). Fracción medida por bin: regiones reales 0.00-0.01; AA de flatShapes3, aaCircle,
  glyph y avatar 1.00; AA JPEG de clip_art 0.73-0.88; escalones del degradado de splash 0.01-0.72. Se usa la versión sin
  pares (vecinos opuestos) porque coincide ±0.05 con "toca el lado de cada extremo" y cuesta una pasada. Resultados: ambos
  repros 3 colores; flatShapes3 3; bench: GENTERA 6 capas, clip_art 3, avatar 3 (sin cambios); splash paletteColors 4 → 6
  (sigue 'photo', offPaletteRatio 0.184); Instagram 8 → null y eagle 16 → null: sus pasos de degradado ya no pasan por AA
  (null es lo correcto para un degradado), lo que obliga a afinar la regla de líneas ruidosas de classify (siguiente punto).
- classify: la rama "paleta null + luma bimodal → lines" (escaneos con ruido) exige además `twoToneOffRatio ≤ 0.5` (fracción
  de píxeles a > 48 de una paleta de 2 colores medianCut+kmeans). Sin eso, Instagram y eagle (null + bimodal tras el cambio de
  paleta) salían 'lines' con fidelidad 0.824 y 0.585 en lugar de 'photo' (0.940 y 0.900). Medido a tol 24 / 48: Instagram
  0.914 / 0.766, eagle 0.963 / 0.838; escaneos sintéticos con ruido por canal ±15..±25 ≤ 0.031 / ≤ 0.018, sepia ±30
  0.688 / 0.015, sepia ±40 0.817 / 0.101. Tol 24 confunde un escaneo ruidoso con un degradado; 48 los separa.
- Anti-ringing del bicúbico: recorte de cada muestra (por canal) al [min,max] de sus 2×2 taps más cercanos. Catmull-Rom
  2-D subía en esquinas un 15.2 % del rango local: gris 8×8 (x<4 && y<4 ? 64 : 192) ×4 daba 44.56..202.06 → 64..192; el
  escalón 1-D 54.63..201.38 → 64..192. Rampas lineales y constantes intactas (ya están entre esos taps). En los fixtures de
  noSpikes la máscara no cambia (medido: nodos e IoU idénticos con y sin recorte en aaCircle, glyph y la línea).
- Memoria de `blurCore` y `bicubicCore`: anillos de filas en lugar de intermedios del tamaño de la imagen (blur: min(2r+1, h)
  filas; bicúbico: 4 filas; la fila fuente s vive en la ranura s % tamaño mientras hace falta y se calcula una sola vez).
  Mismas expresiones en el mismo orden → salida idéntica (los tests conservan el núcleo anterior como referencia: gris ≤ 1e-6,
  RGBA byte a byte). gaussianBlurRaster 4000×4000 RGBA σ 1: arrayBuffers +298.4 MB → +64.7 MB (la salida son 64 MB),
  663 → 601 ms. upscaleRaster 2000² → 4000²: sin el tmp de 128 MB (anillo de 4 filas = 256 kB).
- Tope del modo píxel `MAX_PIXEL_RECTS` = 200 000: ~6 MB de SVG y lo que un navegador aún pinta con soltura; lo que pasa de
  ahí no es pixel art. Se cuentan los rectángulos sin crearlos y no se serializa: ruido 1440×1440 forzado a pixel antes
  2 070 717 rects, SVG de 79 MB, RSS 757 → 1772 MB, 1800 ms; ahora 29 ms, svg '', RSS 368 → 376 MB y aviso que remite a
  Color plano. trace() ya no calcula analyzeSource en un modo pixel explícito.
- Relleno 'auto' de lines en modo máscara de alpha: color más frecuente de los píxeles OPACOS (`dominantInkColor(img, null)`),
  porque en ese modo la tinta son justamente esos píxeles. Antes usaba `info.dominantInk`, que descarta los colores a ≤ 48 del
  fondo compuesto (blanco en una imagen transparente sin borde): un logo blanco o #f4f4f4 sobre transparente salía NEGRO
  (#000000), también en modo automático. Medido (estrella de transparentLogo recoloreada, potrace, U 4): IoU 0.9892 en ambos
  y relleno #ffffff / #f4f4f4. El modo composite sigue con `info.dominantInk`; el logo navy no cambia (#1d3557).
- `'empty-trace'` y la imagen "en blanco": una máscara sin tinta avisa salvo que la luma compuesta Y el alpha sean ambos
  uniformes. Antes cada modo miraba solo su propia fuente, así que el logo blanco sobre transparente forzado a composite (luma
  compuesta uniforme, IoU trazado 0) y una imagen opaca forzada a máscara con invertir (alpha uniforme) daban un SVG vacío en
  silencio. Una imagen totalmente transparente (RGB basura, alpha 0) sigue sin avisar. La luma compuesta solo se calcula en
  modo máscara y solo cuando la máscara ha salido vacía.
- Auditoría de tests débiles (sin cambios de comportamiento):
  · Bench (`tests/bench/realImages.test.ts`): suelos por imagen fidelity ≥ medida − 0.02 e IoU ≥ medida − 0.03 (constantes
    `MEASURED`) y toda muestra debe tenerlos. La columna `naive` re-traza con los MISMOS parámetros resueltos salvo upscale 1 y
    blur 0 (antes perdía `exactPalette: false` de las fotos: splash naive 0.372 → 0.327 con su paleta de 16 colores real).
    Medido el 2026-09-10 (potrace) [antes de la transparencia falsa y de la coherencia espacial; tabla nueva abajo]:

    ```
    image                 dims       mode  U  layers  paths  nodes  corner  naive  bytes    fidel  ssim   iou    mae  pct16  warnings
    GENTERA               1561x1672  flat  2  6       9      1853   0.012   0.095  70527    0.999  1.000  0.999  0.0  0.001  -
    Instagram             3840x2160  flat  1  12      4477   60446  0.020   0.020  2391810  0.940  0.991  0.862  1.6  0.138  photo
    clip_art              290x193    flat  4  3       46     1218   0.065   0.084  41155    0.869  0.865  0.874  6.7  0.126  -
    eagle                 350x350    flat  4  14      316    22702  0.042   0.057  772116   0.900  0.983  0.776  2.9  0.224  photo
    Compartamos avatar    800x800    flat  2  3       44     1027   0.167   0.302  33362    0.995  0.999  0.988  0.2  0.012  -
    splash                740x740    flat  2  12      733    28962  0.322   0.327  821186   0.888  0.940  0.809  4.5  0.191  photo
    ```
  · Esquinas del trazado ingenuo: los círculos AA no lo pueden probar (aaCircle 16..64 px: cornerFraction 0 / 0 en ingenuo y
    suavizado), glyph solo llega a 1.75× (0.333 vs 0.190) y un cuadrado girado tiene esquinas reales. Se usa una elipse 20×6
    girada 4° en 48 px (sin esquinas: toda esquina es escalón): ingenuo 0.250 (2L/6C, IoU@4× 0.9399), suavizado 0.000 (0L/10C,
    IoU 0.9824).
  · Rama de máscara de alpha: el logo navy traza igual forzado a composite (su luma es lineal en alpha); el test usa la estrella
    en blanco y #f4f4f4 (máscara IoU 0.9892, composite 0.0000). Comprobado por mutación: forzando composite en prepareLines solo
    falla ese test.
  · [Fixture sustituido por `fadingBlocks`, ver "Transparencia falsa y coherencia espacial de la paleta": un damero de 1 px no
    tiene núcleo y ya no entra en la paleta.] Color de paleta sin píxeles: gris 64×64 con damero 1 px negro/blanco y cuadrado rojo; paleta exacta de 4 colores, pero con
    U 4 y blurK 0.75 el damero sale gris → 2 capas exactas (#808080, #c81e1e). Comprobado por mutación: sin la guarda de área 0
    salen 4 capas.

- Auto-tuner (`src/tuner`), medido el 2026-09-10 (potrace + vtracer en Node; `tests/tuner/autotune.test.ts`):
  · Línea base: los params recibidos se evalúan primero a resolución completa y compiten con las candidatas, así que el
    resultado nunca puntúa menos que ellos. La parada temprana (score > 0.985 y cornerFraction < 0.15) también vale para la
    línea base: un trazado por defecto ya excelente (aaCircle 0.9934) vuelve tras 1 evaluación.
  · Etapa A sobre un proxy (box-downscale entero hasta ≤ 256 px de lado; la propia imagen si ya cabe) con turdsize / f² para
    que quite las mismas motas. Con proxy real la etapa A solo ordena: únicamente las evaluaciones a resolución completa se
    pueden devolver y solo ellas disparan la parada temprana. Etapa B: top-3 de A (sin repetir salidas idénticas mientras
    queden distintas), agrupadas por (U, blurK) para reutilizar la preparación. Pasada final: vtracer con VTRACER_DEFAULTS
    sobre la mejor preparación. A y B trazan con potrace (con vtracer si potrace no se pudo iniciar).
  · Preparación (reescalado + desenfoque + umbral/paleta) memorizada por (U, capped, σ) con una sola entrada viva: las
    candidatas llegan agrupadas y así no se retienen máscaras de varias preparaciones a resolución completa.
  · Progreso: `total` fijo desde el principio = 1 + 36 + 3·21 + (1 si hay pasada vtracer) = 101. Los alphamax recortados a
    1.334 se conservan como duplicados y las candidatas con la misma entrada resuelta del trazador (motor, U, capped, σ,
    alphamax, opttolerance, round(turdsize·U²), turnpolicy, opticurve; o los params vtracer) se trazan una vez y cuentan como
    hechas. `done` sube de 1 en 1 y `best` es la mejor devolvible hasta ese momento.
  · Presupuesto: no se empieza una candidata si transcurrido + duración de la evaluación anterior en esa misma escala supera
    budgetMs (la línea base siempre corre). Cancelación comprobada antes de cada candidata y otra vez tras yieldToEvents().
  · U de cada candidata = chooseUpscale(tamaño, U pedida).U: una U que pasa del tope de 16 Mpx se convierte en la recortada,
    sin aviso 'upscale-capped' y sin duplicar la U menor.
  · Puntuación: tunerScore con perimeterPx = transiciones 4-vecinas tinta/fondo internas × π/4 (Cauchy–Crofton; disco r 20:
    error < 3 %), sumadas sobre las máscaras que prepara el pipeline a U 1 sin desenfoque (sin el borde de la imagen ni
    máscaras de lienzo completo). Métricas con computeMetrics sobre el color de borde o blanco (`metricBackground`, el mismo
    fondo que compare y el bench) y el IoU de líneas con su Otsu por defecto. [Sustituido: fuente efectiva, `comparisonBackground` y
    guarda de fidelidad; ver "Auto-ajuste y comparación".]
  · Render de candidatas: curvas aplanadas en unidades del viewBox (tolerancia 0.1 px a U×), polilíneas escaladas a 1× y 4·U
    subscanlines por fila: el mismo muestreo que rasterizar a U× + box-downscale (renderAt1x del bench) sin búferes de tamaño
    U². Escalar las curvas antes de aplanar las aplanaba U veces más grueso: hasta 22 niveles de diferencia y −0.003 de
    fidelidad en aaCircle; aplanando primero, en líneas ≤ 1 nivel (fidelidad idéntica a 1e-5). En plano las capas apiladas se
    componen sobre la cobertura 1×, como pinta el navegador el SVG a su tamaño ("conflation" en bordes compartidos): hasta 24
    niveles y ≤ 0.001 de fidelidad frente a componer supersampleado (flatShapes3 0.99221 vs 0.99153).
  · Salida: se replica trace() (mergeParams con los params del clasificador, fallback de motor, capas, avisos en el mismo
    orden y deduplicados) y los tests comprueban que trace(result.params) da el mismo svg, stats, warnings y resolved.
    `params` = los recibidos (mode incluido, p. ej. 'auto') con upscale, blurK, alphamax, turdsize, opttolerance y engine
    ajustados. Modo píxel: nada que ajustar; devuelve trace() tal cual con score = fidelidad de su reconstrucción exacta.
    Medido (default → ajustado):

    ```
    fixture                     default  tuned   evaluadas  done/total  parada      ms
    aaCircle 64/20              0.9934   0.9934    1          1/101     early-exit   19
    aaCircle ingenuo (U 1, σ 0) 0.9755   0.9867    2          2/101     early-exit    4
    glyph 48                    0.9617   0.9909   28         28/101     early-exit   49
    glyph 24                    0.9358   0.9877   24         24/101     early-exit   36
    aaDiagonalLine 1.5          0.9903   0.9903    1          1/101     early-exit    4
    transparentLogo 64          0.9561   0.9848   89        101/101     complete    173
    flatShapes3 96              0.9438   0.9743   71        101/101     complete    327
    flatShapes3 192             0.9750   0.9839   71        101/101     complete    974
    glyph 384 (proxy 192 px)    0.9832   0.9964   38         38/101     early-exit  394
    flatShapes3 192, budget 150 0.9750   0.9750   14         14/101     budget      159
    ```
- Worker (`src/workers`):
  · Protocolo, ampliación aditiva: respuesta `{ type: 'fatal'; id; message }`. esm-potrace-wasm al abortar lanza
    `WebAssembly.RuntimeError('Aborted(…)')` y deja su runtime en estado ABORT; `exit()` lanza `ExitStatus('Program
    terminated with exit(N)')`. El adaptador lo envuelve como `potrace: …` y el worker sigue vivo, pero potrace ya no sirve:
    el handler lo reconoce (`isFatalError`: RuntimeError, Aborted(, exit(, unreachable, memory access out of bounds), responde
    'fatal' a esa petición y 'error' a todas las siguientes, y el cliente recrea el worker.
  · handler: FIFO con yieldToEvents() antes de cada petición, para que los 'cancel' ya recibidos lleguen antes de arrancar la
    siguiente. Cancel de una petición en cola → 'cancelled' inmediato y no se ejecuta; de la que está corriendo → bandera
    (tune para en una candidata; trace/compare que terminan igualmente responden 'cancelled'). Solo trace, tune y compare son
    cancelables; init/setSource/classify siempre corren. Memo: clasificación de la fuente y los últimos 4 trazados por params
    canónicos (claves ordenadas, undefined fuera), vaciado por setSource e init. Errores con prefijo en español por operación
    ("No se pudo vectorizar la imagen: …"). trace/tune sin init previo inicializan los motores sin URL de vtracer.
  · compare: original y renderizada compuestas sobre `metricBackground(info)` (color de borde o blanco); diffHeatmap sobre
    ambas compuestas; tamaños distintos → error. [Sustituido: fuente efectiva de `traceInput` y `comparisonBackground`; ver
    "Auto-ajuste y comparación".]
  · client: una llamada superada se resuelve con null en el acto y se envía 'cancel'; su entrada sigue registrada hasta el
    ack del worker, para saber qué petición estaba en curso. Recuperación: tras onerror/onmessageerror la llamada en curso es
    la más antigua sin responder (el worker es FIFO) y es la única rechazada; con 'fatal', la indicada. Se crea un worker
    nuevo con init, la última fuente que el viejo confirmó (salvo que la llamada muerta fuera un setSource: esa imagen no se
    reenvía y lo que venga detrás responde "no hay ninguna imagen cargada" en vez de usar la anterior o repetir la caída) y se
    reenvían en orden las llamadas pendientes con búferes nuevos. 3 muertes seguidas sin ninguna respuesta intermedia → se
    rechaza lo pendiente (y ready() si aún no había resuelto) y la siguiente llamada crea un worker nuevo, que recibe antes la
    última imagen pedida con setSource (salvo que la llamada muerta fuera ese setSource; un setSource no manda antes la
    anterior). Antes llegaba sin imagen y todo trace/compare respondía "no hay ninguna imagen cargada" con la imagen en
    pantalla, también al pulsar Reintentar. terminate():
    trace/tune/compare pendientes → null; el resto y las llamadas posteriores rechazan "El procesador de imágenes está cerrado.".
  · Tests en Node: el cliente se prueba con un Worker falso que ejecuta el handler real con structuredClone + transfer y
    entrega asíncrona. Una traza real de potrace se resuelve entera en microtareas, así que el test de cancelar una traza en
    curso usa un trazador que espera un temporizador (en el worker real el cancel llega entre tareas igual).
  · Build comprobado con Vite (entrada client.ts): el worker sale como chunk aparte con potrace dentro y vtracer.wasm como asset.
- UI (`src/ui`, `src/styles`, `src/platform/decode.ts`, `src/dev/fixtures.ts`):
  · Contrato: `src/ui/clientContract.ts` replica la interfaz pública de `WorkerClient` como `TraceClient` estructural; la UI no
    importa client.ts y `tests/ui/clientContract.test.ts` comprueba en el typecheck que `WorkerClient` la satisface.
    `mountApp(root, client, { devFixtures })` devuelve el desmontaje: cancela un ajuste en curso y quita los listeners globales,
    pero NO llama a `client.terminate()` (el cliente es de quien lo crea).
  · Modo: tras clasificar, la UI guarda `{ ...classify.params, mode: 'auto' }` y el chip Auto muestra "Detectado: …". Al worker
    llega siempre el modo concreto (`traceParamsFor`: el detectado mientras siga Auto) y nunca `optimize`: SVGO es solo de
    salida y conmutarlo no re-traza. Cambiar de modo conserva los parámetros propios de otros modos, que cada modo ignora.
  · Re-trazado: cada cambio de control programa `trace` a 200 ms; si los parámetros resueltos contra los defaults del modo
    (`diffParams`) coinciden con la última petición no se re-traza. Un resultado null (superado) se ignora; `traceSeq`,
    `loadSeq` y `tuneSeq` descartan respuestas anteriores a una imagen nueva o a un ajuste aplicado. Si la carga de una imagen
    nueva no acaba en pantalla (falla, o la supera otra que no llega al worker) se reenvía la imagen que sigue en pantalla; ver
    "Integración".
  · Visibilidad (`controlSchema.ts`): Suavizado, Tolerancia de curva y Manchas mínimas solo con Potrace; los 6 parámetros de
    VTracer solo con VTracer; Umbral, Invertir y Transparencia solo en líneas; Colores, Paleta exacta y Capas solo en plano;
    Motor, Reescalado, Desenfoque y Fondo en líneas y plano; Rejilla solo en píxel; Optimizar siempre. "Precisión" de VTracer
    = `pathPrecision` (en modo binario `colorPrecision` no influye). Colores y Rejilla aceptan 'auto' (botón "Auto" para
    volver); mientras tanto el pulgar se sitúa en `paletteColors ?? 8` y en `grid`.
  · Ajuste automático: `client.tune(traceParamsFor(ui), 3000, …)` con el fieldset de controles deshabilitado. La barra muestra
    done/total tal cual: el tuner cuenta candidatas acumuladas sobre un total fijo de toda la ejecución (medido con el cliente
    real en flatShapes3 192: "Etapa A 25/101", luego "Etapa B 58/101"); un reparto por tramos fijos de etapa saltaba de 15 % a
    77 %. La app se queda con el máximo, así que nunca retrocede; puede terminar antes del total (early-exit o presupuesto).
    Al terminar, `applyTunedParams` fusiona
    los params del tuner sobre los de la UI (Auto se mantiene si el tuner conservó el modo detectado; `optimize` no se toca),
    se muestra el SVG ajustado sin re-trazar y se listan los cambios ("Suavizado: 1,00 → 1,15"). Cancelado (null) → mensaje y
    re-trazado solo si los parámetros actuales no se habían pedido ya. [Sustituidos el texto de ayuda y el mensaje final: ver
    "UI: tablero pintado, resumen del ajuste y máscara de transparencia".]
  · Avisos: `mergeWarnings` = avisos del trazado + los del clasificador que falten ('thin-strokes' del clasificador solo en
    líneas). Acciones: photo → "Usar 32 colores" en plano, "Cambiar a Color plano" en otro modo; thin-strokes → "Reescalar a
    4×" si el U usado < 4, si no "Reducir desenfoque" (0.15); too-many-rects (píxel) y empty-trace (líneas) → "Cambiar a Color
    plano"; empty-trace en plano → "Quitar manchas mínimas" (turdsize o filterSpeckle a 0); engine-unavailable → "Usar <el otro
    motor>" si está disponible; upscale-capped y large-input sin acción. [Ampliado: empty-trace con la máscara como salida y
    baked-checkerboard, ver "UI: tablero pintado, resumen del ajuste y máscara de transparencia".]
  · Decodificación: el formato se decide por la firma de bytes (PNG, JPEG, GIF87a/89a, BMP, RIFF…WEBP), no por el MIME, que
    falla con imágenes pegadas o renombradas; AVIF, TIFF, SVG o HEIC se rechazan nombrando el formato. Límite: cada lado
    ≤ 4096 px (lectura literal de "entrada máxima 4096×4096"), comprobado tras `createImageBitmap(file, { imageOrientation:
    'from-image' })`; GIF da el primer fotograma. OffscreenCanvas si existe, si no <canvas>; `getImageData` en sRGB.
  · Rasterizado para medir (`rasterize.ts`): <img> con data URL, `img.decode()`, dibujo a 2× y reducción a 1× con
    `imageSmoothingQuality 'high'`. Si el lienzo 2× supera 16 777 216 px (límite de área de Safari/iOS, que dibuja en blanco
    sin error) se dibuja directamente a 1× (p. ej. 3840×2160). Un SVG vacío no se mide.
  · Nivel de fidelidad sobre el valor MOSTRADO (décimas de %): ≥ 97,0 ok, ≥ 90,0 aviso, resto mal (0.96951 se muestra 97,0 % y
    es ok; comparar `0.97 * 100` en coma flotante no es fiable).
  · Zoom relativo a "Ajustar" (1× = imagen entera con 16 px de margen), 1×–16×; Ctrl/⌘+rueda anclado al cursor (un evento
    multiplica como mucho ×1,62), pasos 1-1.5-2-3-4-6-8-12-16, arrastre (o espacio+arrastre), flechas y +/−/0 con el foco en
    el lienzo. El contenido se dimensiona en px de layout (no con `scale`) para que el SVG se re-rasterice nítido;
    `image-rendering: pixelated` en el original cuando 1 px fuente ocupa más de 1 px CSS. "Lado a lado" comparte la vista.
  · Nodos: `extractNodes` (extractPaths + parsePathData + transform) marca extremos L como esquinas (cuadrado, overlay-corner) y
    C/Q como curvas (círculo, overlay-curve), el mismo criterio que `pathStats`; se calcula al activar el overlay y se dibuja
    en un canvas en espacio de pantalla (tamaño fijo, recortado al viewport). Paths no parseables se omiten sin lanzar.
  · SVGO (`src/ui/output.ts`, en lugar de `src/svg/optimize.ts`): `import('svgo/browser')` perezoso (chunk propio),
    `preset-default` con `mergePaths: false` y `floatPrecision: 4`, sin multipass. SVGO 4 ya no incluye `removeViewBox` en
    preset-default: el viewBox se conserva sin override (sobrescribir un plugin ajeno al preset solo emite un warning). Solo se
    aplica al descargar o copiar, con caché del último SVG. Test: viewBox/width/height intactos, capas separadas, ≤ 4 decimales.
  · Descarga: Blob + <a download> temporal; nombre = fuente sin extensión + ".svg" (caracteres prohibidos → "-", vacío →
    imagen.svg); una imagen pegada se llama imagen-pegada.png. Copiar: `navigator.clipboard.writeText` con aviso de error.
  · Fixtures de desarrollo (`?synth=`): circle aaCircle(128, 40), line aaDiagonalLine(128, 1.5, 30), glyph glyph(96), flat
    flatShapes3(192), sprite nearestUpscale(sprite32(1), 4) (128 px, rejilla detectable ≥ 4), logo transparentLogo(128).
    `mountApp` los carga con `import('../dev/fixtures')` dentro de `if (import.meta.env.DEV && opts.devFixtures === true)`
    (2026-09-10): en producción la rama es código muerto, Rolldown quita el import y `src/dev/synth.ts` no entra en ningún
    chunk (antes iba en el principal). El módulo llega de forma asíncrona: si la app se desmontó entretanto no carga nada, y
    un fallo del import se muestra en el estado vacío. `src/ui/entry.ts` sigue importando `SYNTH_FIXTURES` de forma estática,
    así que en `index-*.js` quedan la lista de seis nombres y la función de los enlaces `?synth=` (inertes sin `devFixtures`);
    desaparecen del todo añadiendo `import.meta.env.DEV &&` a la condición de entry.ts.
  · Diseño (2026-09-10; detalle y tablas de contraste en DESIGN.md, "Decisiones de implementación (UI)"):
    `--signal-ok/warn/bad` se redefinen por tema y sirven como texto (≥ 4.5:1 sobre superficie y papel en ambos temas; ya no
    hay `--signal-*-text`) y `--on-accent` va por tema; `tests/ui/contrast.test.ts` lee `src/styles/tokens.css` y comprueba
    cada par en uso. JetBrains Mono Variable (`@fontsource-variable/jetbrains-mono`, `@import` al principio de
    `src/styles/app.css`; Vite resuelve el paquete y emite sus woff2) en `--font-mono` con `tabular-nums` para las cifras.
    Iconos Phosphor Regular reales: `src/ui/icons.ts` importa los SVG de `@phosphor-icons/core` con `?raw` y copia sus `d`
    (misma API `IconName` e `icon(name, size)`; viewBox 0 0 256 256, `fill: currentColor`); `tests/ui/icons.test.ts`. El
    aviso MIT va como comentario legal (`/*!`) sobre `SOURCES`, pero Vite 8 lo elimina por defecto; se conserva con
    `build.rolldownOptions.output.comments.legal: true` (comprobado con la API de build). Cortes de layout en 1100 y 760 px
    (antes 1100, 900 y 600). Build (vite build) tras el cambio: `index-*.js` 70 268 B (gzip 24 772; antes 72 160 / 26 078),
    `index-*.css` 38 145 B (gzip 12 017; antes 33 263 / 9 670) y 5 subconjuntos `jetbrains-mono-*-wght-normal-*.woff2` de
    7 504 a 40 404 B.
- Integración (`src/main.ts`, flujo UI ↔ cliente, build), 2026-09-10:
  · `src/main.ts` importa la fuente (`@fontsource-variable/manrope`; JetBrains Mono entra por `src/styles/app.css`) y los
    estilos (`src/styles/app.css`), que salen de
    `src/ui/app.ts` para que `mountApp` no tenga efectos globales; crea `new WorkerClient()` tipado como `TraceClient` (el
    typecheck lo acepta sin tocar ninguno de los dos lados) y monta con `devFixtures: import.meta.env.DEV`. En desarrollo
    `import.meta.hot.dispose` desmonta la app y termina el cliente, para no acumular workers en cada recarga en caliente.
  · Imagen nueva frente a peticiones de la anterior (`src/ui/sourceSync.ts`): el worker es FIFO y la app solo cambia `loaded`
    cuando responden setSource y classify. En esa ventana un trace con debounce, una medición (compare) o un ajuste de la
    imagen anterior llegaban al worker DETRÁS del setSource nuevo: se trazaba o medía la imagen nueva con los parámetros de la
    vieja y el resultado se pintaba sobre la vieja (pasajero si la carga terminaba bien; permanente si fallaba, porque el
    reenvío de la imagen anterior llegaba después). Y soltar un archivo no válido mientras se analizaba uno válido dejaba el
    worker con el válido y la pantalla con la imagen anterior (la carga superada salía sin reenviar nada). Ahora trace y
    compare esperan mientras haya un cambio de fuente pendiente y vuelven a comprobar `traceSeq` y `loaded` antes de enviar;
    "Ajuste automático" no arranca durante la carga; y un intento que no acaba en pantalla (fallido o superado) reenvía la
    imagen mostrada solo si la suya fue la última enviada (si un intento posterior ya mandó la suya, no la pisa). Tests:
    `tests/ui/sourceSync.test.ts`.
  · Errores: `withErrorContext(contexto, mensaje)` (`format.ts`) no antepone el contexto de la UI cuando el mensaje ya es una
    frase completa que empieza por "No se pudo" (los prefijos por operación del handler y los fallos de arranque o envío del
    cliente). Antes se leía "No se pudo vectorizar: No se pudo vectorizar la imagen: …" o "No se pudo medir la fidelidad: No
    se pudo comparar el resultado…". Los mensajes del cliente que no nombran la operación ("El procesador de imágenes falló y
    se reinició (…)") conservan el contexto.
  · Ajuste que falla: como al cancelar, se re-traza si los parámetros actuales no se habían pedido. Un cambio con debounce
    pendiente al pulsar "Ajuste automático" se descartaba y la barra de trazado quedaba activa para siempre.
  · Build (`npm run build`, vite 8.2.2; gzip con `gzip -c`):

    ```
    fichero                                    bytes    gzip
    assets/index-*.js (UI + cliente)          72 160   26 078
    assets/index-*.css                        33 263    9 670
    assets/trace.worker-*.js                 156 557   57 667   esm-potrace-wasm, vtracer-web, core, metrics, tuner
    assets/vtracer-*.wasm                    136 862   59 219
    assets/svgo.browser-*.js (perezoso)      560 351  162 772
    assets/manrope-*-wght-normal-*.woff2     8 520 .. 24 836    5 subconjuntos (woff2 ya comprimido)
    ```

    Según los sourcemaps, el chunk principal no contiene ningún paquete (ni esm-potrace-wasm ni vtracer-web) y el worker
    contiene los dos. Las dos únicas apariciones de `document.` en el worker son de esm-potrace-wasm
    (`document.createElement("canvas")` para entradas Blob o HTMLImageElement; el adaptador le pasa ImageData); ninguna es de
    nuestro código. Su `import 'node:fs'` se sustituye por `__vite-browser-external`. Referencias con la base:
    `new URL('/image2svg/assets/trace.worker-*.js', import.meta.url)` en el principal y `/image2svg/assets/vtracer-*.wasm` en
    el worker. Avisos esperados del build: `vtracer_bg.wasm` (búsqueda por defecto de vtracer-web, que no se usa porque el
    worker pasa la URL), la variable CommonJS `module` de esm-potrace-wasm y el tamaño de SVGO (> 500 kB, solo se carga al
    optimizar). `src/dev/synth.ts` ya no entra en producción; de `src/dev/fixtures.ts` solo queda la lista de nombres que
    importa entry.ts (ver "Fixtures de desarrollo" en UI). `vite preview`: `/image2svg/` text/html, JS text/javascript, CSS text/css,
    `.wasm` application/wasm, woff2 font/woff2, favicon image/svg+xml; todos 200.
  · `scripts/prepare-samples.sh` hacía `cd "$(dirname "$0")"` y buscaba `scripts/img/*` (con `set -e` fallaba en el primer
    archivo); ahora hace `cd "$(dirname "$0")/.."` y escribe en `samples/` de la raíz, que es lo que lee el bench.

- Transparencia falsa y coherencia espacial de la paleta (`src/core/bakedBackground.ts`, palette, classify, pipeline), 2026-09-10.
  Dos imágenes del usuario (clip_art 290×193, splash 740×740) son PNG opacos con un tablero de ajedrez pintado; el pipeline lo
  convertía en capas grises de fondo y clip_art perdía los peces naranja.
  · Detección (`detectBakedCheckerboard`, solo la banda de borde): clip_art celda 20.007, offsets 19.95/19.99 (≡ 0), niveles
    238/254, borderMatchRatio 1.000, 2.5 ms; splash celda 32.519 (tablero reescalado: las transiciones del borde avanzan 32.51 px),
    offsets 27.06/25.75, niveles 153/254, 1.000, 6 ms. Celda fraccionaria obligada: con una celda entera el error acumulado en
    22 celdas llega a 10 px. Periodo por coherencia de fase (media de exp(2πi·pos/c) de las transiciones de nivel con posición
    subpíxel) en una rejilla de paso c²/(8·lado); los submúltiplos también son coherentes y los descarta la paridad (≈ 50 %).
    Sin detección: GENTERA, Instagram (17 ms), eagle, avatar, aaCircle, glyph, flatShapes3, sprite32, transparentLogo, noisePhoto,
    `chessboardGraphic` (tablero real sobre fondo sólido) y un tablero con un 2 % de píxeles transparentes.
  · Máscara (`bakedBackgroundMask`). Niveles locales: en splash el gris de las celdas va de 153 en el borde a 224 junto al anillo
    (un brillo pintado encima) y el blanco se queda en 253-254; con los niveles del borde solo el 52.1 % de la imagen salía fondo.
    Mediana por celda (interior a 2 px de sus bordes, fiable si >= 50 % está a +-8 de ella), celdas que se unen desde las que
    coinciden con el nivel del borde si una celda de su paridad a <= 2 celdas difiere <= 24 y sus 4 vecinas unidas (la otra
    paridad) mantienen el orden de niveles con >= 8 de diferencia (así un rectángulo claro que tapa varias celdas nunca se une),
    relleno BFS de cada paridad e interpolación bilineal entre centros: 75.4 %. Candidatos = píxeles neutros a +-8 del nivel
    local o del de borde (el campo se extrapola mal junto al borde de la imagen); junto a una frontera de celda (< 1.5 px)
    también cualquier luma entre los niveles con +-16 de rebote: 80.8 % (las líneas grises de 1 px entre celdas eran mezclas
    y undershoot 142-152); con las motas y los niveles de borde, 81.6 % (clip_art 87.1 %; 32 ms y 14 ms). Componentes 4-conexas de candidatos: fondo si tocan el borde o si >= 90 % de sus píxeles a >= 1 px de
    una frontera muestran el nivel de su paridad (contraformas de letras: de una o de varias celdas); un blob que rompe la
    paridad y aguanta 2 erosiones (> 4 px de ancho) dentro del fondo es una forma clara real y se conserva. Motas JPEG: grupos
    4-conexos de <= 16 px de píxeles no candidatos a <= 32 RGB de un nivel local que tocan el fondo se unen a él (clip_art: halos
    de croma con spread 13-40 junto a letras y peces). Fixtures (`bakedCheckerLogo`, ruido +-4): IoU máscara/verdad 0.9940-0.9945,
    alpha < 128 del efectivo/verdad 0.9930-0.9936; contraformas 154/154 en fondo; rectángulo blanco interior 680/680 conservado.
  · Franja AA (`applyBakedBackground`): píxeles no candidatos a <= 2 px del fondo reciben alpha = proyección sobre L→I (L = media del
    fondo en su 5×5, I = el píxel no fondo más lejano de L en ese 5×5) y color I; >= 0.95 o |I−L| < 24 los deja igual. Medido
    contra el logo ideal sobre blanco (potrace, trazado del efectivo): estimar alpha 0.9978 / IoU 0.9972 (celda 10), 0.9986 / 0.9986
    (16), 0.9930 / 0.9855 (contraformas), 1 capa en líneas; conservar el color con alpha 255: 0.9781 / 0.9518, 0.9826 / 0.9608,
    0.9631 / 0.9192 y 4-7 capas en plano (el halo claro se vuelve tinta). Se estima el alpha.
  · Integración: `analyzeSource(img, 'auto')` mide la fuente efectiva y guarda la detección; trace() traza
    `effectiveSource(img, info, resolved)` en líneas y plano (transparente: sin capa de fondo) y antepone el aviso
    'baked-checkerboard'; con 'keep' y un info que aplicó un tablero recalcula `analyzeSource(img, 'keep')` (`traceInput` hace lo
    mismo para quien ya tiene info: tuner). Un modo píxel explícito sin info solo ejecuta la detección. El bench y la
    comparación del worker miden contra la fuente efectiva sobre `borderColor ?? blanco`. Aviso (una línea, sin rayas): "La
    imagen no es transparente de verdad: lleva pintado un tablero de ajedrez (cuadros de N px) que imita la transparencia. Se
    trató como fondo transparente y se excluyó de la comparación de fidelidad. Si el tablero forma parte del diseño, puedes
    conservarlo." Un único píxel opaco (144,145,144) en el anillo de splash hacía borderColor gris y la fidelidad medida sobre
    gris daba 0.868-0.874 frente a 0.917 sobre blanco y 0.916 sobre negro; el rango de mezcla con los niveles de borde lo quita.
  · Clasificación con fondo transparente. clip_art efectivo salía 'lines' por la regla de escaneo ruidoso (paleta null, luma
    bimodal, twoToneOffRatio 0.18): un solo relleno, peces magenta. Con transparencia la paleta solo tiene tintas: 'lines' exige
    <= 1 color y no aplica esa regla. Y la regla de foto usa `offPaletteShare` = offPaletteRatio × (1 − transparentRatio): en un
    logo sobre transparencia los bordes son casi todo lo opaco (clip_art efectivo 0.306 de lo opaco, 0.037 de la imagen; con el
    tablero pintado 0.082); los opacos no cambian.
  · Paleta: coherencia espacial en lugar del suelo del 0.5 % (exactPaletteDetailed y consolidatePalette). Núcleo = píxel cuyo
    vecino de los 8 (bordes con clamp, transparentes nunca coinciden) tiene su misma etiqueta (centro más cercano ponderado);
    sobrevive con núcleo >= max(12 px, 0.02 % de los contados) y >= 5 % de sus píxeles. Medido frente a la regla pedida (7 de 8
    vecinos y color a tolerancia del centroide):
    - 7 de 8: la banda de ringing de clip_art efectivo (190,20,104) tiene 33 px núcleo (tol 24) y sobrevive; 8 de 8: 8-9 px.
    - Tolerancia de color: a 24 descarta pasos reales de degradado (eagle (139,114,122) núcleo 0 y (32,110,161) 4; noisePhoto
      (35,101,84) 5); a 48 vacía clusters de compromiso (buildPalette(flatShapes3, 2) devolvía 1 color); sin tolerancia: eagle
      mínimo 369, noisePhoto 61 (semilla 2: 21), splash efectivo 982, Instagram (254,140,192) 0 (ya caía con el 0.5 %). Nunca
      cambió la decisión sobre el ringing: no hay tolerancia.
    - Umbral de candidatos >= 12 px además del 0.05 %: sobre 5 235 px opacos el 0.05 % son 2.6 px y el ruido JPEG llenaba los 32
      dominantes antes de fusionar (paleta null: foto). Umbral 0/4 px null, 8 px 2 colores pero noisePhoto dejaba de ser null
      (7), 12 px correcto en todo. Se descartó contar el tope de 32 tras fusionar: Instagram pasaba a 12 colores exactos sin
      aviso de foto y el escaneo ruidoso del test de classify a 2 colores.
    - Fracción de núcleo >= 5 %: sin las motas pequeñas la banda de ringing se queda tramos contiguos (44 px núcleo de 1 084).
      Fracciones medidas: ringing 0.010-0.026; clusters reales >= 0.142 (noisePhoto semilla 2), eagle 0.169, magenta 0.27,
      naranja 0.32-0.56.
    - Los píxeles de un cluster descartado cuentan para el más cercano pero no mueven su color: las líneas de 1 px de un dibujo
      (10 % de la imagen) arrastraban el blanco a (230,230,230), offPaletteRatio 1 y 'photo' en vez de 'lines'.
    - consolidatePalette descarta un cluster por pasada (el de menor fracción de núcleo): una región partida entre dos clusters
      de k-means no tiene núcleo en ninguna mitad hasta que uno absorbe al otro (descartando todos a la vez clip_art efectivo
      acababa con 1 color).
    - Consecuencias conocidas: un color que solo aparece en trazos de <= 2 px (sin píxel con sus 8 vecinos iguales) sale de la
      paleta en modo plano; en sprite32 a 1× los bloques de 2-4 px pierden su color (se clasifica 'pixel' y no usa la paleta).
      [Sustituido: además cambiaba el modo ('lines' con 2 tintas) y se perdían acentos de ~5 px en iconos pequeños; ahora un
      rasgo distinto conecta y lejos de todo color coherente sobrevive, ver "Revisión en el navegador: contornos finos".]
    Resultado: clip_art efectivo [222,4,114] (4 293 px) + [249,176,51] (443 px) (2 capas: magenta y naranja; sin ringing ni gris); flatShapes3 3,
    GENTERA 6, avatar 3, Instagram/eagle/noisePhoto siguen null (foto). Test de pipelineUnits "color sin píxeles": el damero de
    1 px ya no llega a la paleta; `fadingBlocks` (cuadrado rojo opaco y cuatro bloques azules 4×4 con alpha 136 que el
    reescalado 4 + desenfoque σ 4 px deja por debajo de 128). Comprobado por mutación: sin la guarda de área 0 sale una capa azul.
  · Bench (potrace; fidelidad frente a la fuente efectiva), antes → después:

    ```
    image                 dims       mode  U  layers  paths  nodes  corner  naive  bytes    fidel  ssim   iou    mae  pct16  warnings
    GENTERA               1561x1672  flat  2  6       9      1853   0.012   0.095  70527    0.999  1.000  0.999  0.0  0.001  -
    Instagram             3840x2160  flat  1  12      4477   60446  0.020   0.020  2391810  0.940  0.991  0.862  1.6  0.138  photo
    clip_art              290x193    flat  4  2       46     612    0.082   0.080  20382    0.961  0.992  0.913  1.2  0.087  baked-checkerboard
    eagle                 350x350    flat  4  14      316    22702  0.042   0.057  772116   0.900  0.983  0.776  2.9  0.224  photo
    Compartamos avatar    800x800    flat  2  3       44     1027   0.167   0.302  33362    0.995  0.999  0.988  0.2  0.012  -
    splash                740x740    flat  2  16      2167   34870  0.063   0.077  1188237  0.899  0.955  0.816  2.4  0.184  baked-checkerboard,photo
    ```
    clip_art 0.869 → 0.961 (IoU 0.874 → 0.913, 3 → 2 capas, 1218 → 612 nodos); splash 0.888 → 0.899 (IoU 0.809 → 0.816,
    cornerFraction 0.322 → 0.063); el resto idéntico a la milésima. Suelos `MEASURED` actualizados.
  · blurK por defecto para fuentes JPEG: evaluado, no adoptado. Bloqueo medido como paso medio de luma (<= 24) por fase módulo 8:
    clip_art tiene picos en las fases 3 y 7 en ambos ejes (x 7.58 y 5.13 frente a una mediana de 2.57, ratio 2.95; y 2.46: bloques
    de 4 px, un JPEG reducido a la mitad); avatar 1.08/1.12, eagle 1.03/1.01, Instagram 1.01/1.06, splash 1.24/1.09 y GENTERA
    1.40/2.24 (PNG plano con pocos pasos: el ratio solo no basta como detector). clip_art (fidelidad / cornerFraction): blurK
    0.35 0.9606 / 0.082, 0.5 0.9599 / 0.074, 0.65 0.9589 / 0.073, 0.8 0.9572 / 0.052, 1.0 0.9548 / 0.063: la mejor caída de
    esquinas es −37 % (< 50 %) y siempre con menos fidelidad; avatar 0.9946 → 0.9918 y eagle 0.9000 → 0.8683 a 1.0 (splash, medido
    antes del último arreglo de borde, 0.8682 → 0.8572). Defaults sin cambios.

- Auto-ajuste y comparación: fuente efectiva, guarda de fidelidad, resúmenes antes → después, rejilla de píxel que no divide la
  imagen y pista de 'empty-trace' (`src/tuner`, `src/workers`, `src/core/pixelExact.ts`, pipeline), 2026-09-10. Problemas vistos
  al probar la app compilada en el navegador con las imágenes del usuario.
  · Fuente efectiva en las métricas. Ni `compare` del worker ni el tuner la usaban (lo que dice "Transparencia falsa" de la
    comparación del worker no estaba implementado): medían contra los píxeles pintados, y el tuner además trazaba las candidatas
    sobre ellos, así que sus params no reproducían trace() en una imagen con tablero. Ahora los dos parten de
    `traceInput(img, info, params)` (tablero transparente salvo 'keep'; con 'keep', `analyzeSource(img, 'keep')`, que el handler
    memoriza por fuente igual que la fuente efectiva) y componen original y SVG sobre `comparisonBackground`: en plano, el fondo
    resuelto si es opaco (el SVG lo pinta en todo el lienzo); si no, borde o blanco. El tuner antepone 'baked-checkerboard' como
    trace(). Protocolo, ampliación aditiva: la petición `compare` acepta `bakedBackground?` y `background?`
    (`client.compare(rendered, mode, target?)`, target = resolved del trazado medido; sin target se mide como 'auto').
    Medido con el SVG rasterizado por scanline y transparente (como el lienzo del navegador), fidelidad actual (contra los
    píxeles pintados, lo de antes): bakedCheckerLogo celda 10 0.9938 (0.7092); clip_art 0.9560 (0.7461); splash 0.8983 (0.5512);
    transparentLogo en plano con fondo (200,30,30) 0.9962 sobre ese fondo (0.3452 sobre blanco). Comprobado por mutación:
    comparar contra `s.img` hace fallar el test del handler (0.709 < 0.97).
  · Proxy de la etapa A premultiplicado cuando la fuente tiene transparencia (el RGB 0 de los píxeles transparentes de la fuente
    efectiva oscurecía los bordes del proxy): resultados idénticos en clip_art y splash con 3 s; se conserva por coherencia con
    el remuestreo del pipeline.
  · Guarda de fidelidad (`FIDELITY_GUARD` = 0.005, `outranks`). La UI promete que el ajuste aplica "la de mayor fidelidad", pero
    la puntuación resta esquinas y complejidad y podía devolver menos fidelidad que la línea base. Regla: una candidata solo
    sustituye al resultado si su fidelidad >= la de la línea base − 0.005; entre esas gana la mayor puntuación, con empate gana
    la de menos esquinas (segmentos L) y después la de menos nodos. La parada temprana exige también estar dentro de la guarda.
    Medido (fidelidad del tuner línea base → ajustada, esquinas, nodos; potrace + vtracer en Node):

    ```
    fixture / imagen                        sin guarda                              con guarda
    glyph 96                                0.9978 → 0.9926 (−0.0053), 4 → 0, 44    0.9978 → 0.9936 (−0.0042), 4 → 0, 30
    glyph 24 / 48 / 384                     +0.0187 / −0.0000 / −0.0003, esquinas a 0 (igual con guarda)
    círculo pixelado (aaCircle 48/16 ×3)    0.9722 → 0.9706 (−0.0017), 28 → 0, 104 → 77 (igual con guarda)
    transparentLogo 64                      0.9962 → 0.9930 (−0.0032), 8 → 0 (igual con guarda)
    clip_art (presupuesto 3 s)              0.9587 → 0.9584 (−0.0003), 50 → 0, 612 → 420, 20 382 → 15 073 B (igual)
    eagle (3 s)                             0.8680 → 0.8644 (−0.0037), 946 → 68, 22 702 → 16 349 (igual)
    avatar (3 s)                            0.9946 → 0.9952, 171 → 3, 1 027 → 1 488 (igual)
    splash (3 s)                            sin cambios: el presupuesto se acaba en la etapa A
    ```

    La tabla de "Auto-tuner" sigue valiendo (mismas puntuaciones y evaluaciones). Tests: glyph 24/48/96 con fidelidad ajustada
    >= línea base − 0.005 (con la guarda desactivada falla en glyph 96) y el círculo pixelado, donde gana una traza con 0.0017
    menos de fidelidad y ninguna esquina. Nota: la regla pedida sigue admitiendo la pérdida de glyph 96 (0.0042), del mismo
    orden que la que se vio en el navegador (99,5 % → 99,1 %).
  · Semillas. Sin proxy (lado <= 256 px) las candidatas de la etapa A fuera de la guarda van detrás al elegir semillas
    (`Ranked.eligible`). Se probó lo mismo en el proxy, midiendo en él la línea base: a baja resolución las diferencias de
    fidelidad se amplifican y empeoraba imágenes reales (clip_art puntuación 0.9485 con 570 nodos frente a 0.9502 con 420; eagle
    se quedaba en la línea base, 0.8504, frente a 0.8555 dentro de la guarda). En el proxy se ordena solo por puntuación.
  · Resúmenes para la UI (antes → después): `TuneResult`, la respuesta 'tuned' y `TuneOutput` ganan `baseline` y `tuned`
    (`TuneSummary` { fidelity, cornerFraction, nodeCount, bytes }). La línea base son los params recibidos medidos por el tuner
    (bytes del SVG que da trace() con ellos), la ajustada las stats del resultado; en modo píxel son iguales. Cuidado al
    mostrarlos: la fidelidad del tuner (render a 1× componiendo coberturas, ver "Auto-tuner") sale por debajo de
    renderAt1x/bench en pilas de muchas capas (eagle 0.8680 frente a 0.9000, splash 0.8949 frente a 0.8994, clip_art 0.9587
    frente a 0.9606, GENTERA 0.9984 frente a 0.9993, avatar igual); no conviene mezclarla con la medida en el navegador.
  · Píxel con un gridScale que no divide la imagen: `downscaleNearest` usaba floor, así que un 10×10 con rejilla 3 daba un SVG
    de 9×9 que la UI estiraba y las métricas comparaban píxeles desalineados. Ahora usa ceil (se conservan los bloques
    parciales), el SVG mide siempre lo que la fuente y, si la rejilla no es exacta, viewBox y rectángulos van en píxeles fuente
    recortados a la imagen. Con una rejilla exacta el SVG no cambia ni un byte (sprite32 ×3 con auto o gridScale 3). La
    reconstrucción del tuner cubre ya los bloques parciales (puntuación 1 en el 10×10).
  · 'empty-trace' en composite con alpha no uniforme (la forma está en la transparencia: un logo claro compuesto sobre el papel
    desaparece): "No se encontró tinta que vectorizar: el SVG sale vacío aunque la imagen tiene zonas transparentes. Prueba
    Transparencia: Máscara, que traza la silueta de las zonas opacas." El resto de casos conserva el texto del umbral. En la UI
    la opción se llama hoy "El canal alfa es la tinta". [La UI la llama ahora "Máscara (el canal alfa es la tinta)", ver abajo.]

- UI: tablero pintado, resumen del ajuste y máscara de transparencia (`src/ui`, `src/styles/controls.css`, `tests/ui`),
  2026-09-10. Continuación de la prueba en el navegador.
  · Contrato: `clientContract.ts` replica `TuneOutput` con `baseline` y `tuned` (`TuneSummary`, reexportado de protocol.ts) y
    `compare(rendered, mode, target?)` con `CompareTarget`; `tests/ui/clientContract.test.ts` exige en el typecheck tipos
    idénticos (TuneOutput, CompareTarget, parámetros de compare, retorno de tune). La app mide cada trazado con `target` =
    `bakedBackground` y `background` de su `resolved`: sin él, un SVG con el tablero conservado se mediría contra la fuente
    efectiva (tablero transparente) y uno plano con fondo propio contra el color de borde.
  · Ajuste automático. Ayuda (`TUNE_HINT`): "Busca durante 3 s el mejor equilibrio entre fidelidad, esquinas y nodos, sin
    perder más de 0,5 puntos de fidelidad." `TUNE_FIDELITY_GUARD` copia `FIDELITY_GUARD` sin importar el tuner en el chunk
    principal y un test fija que coinciden. No promete "menos nodos": el ajuste puntúa un equilibrio y avatar pasa de 171 a 3
    esquinas pero de 1 027 a 1 488 nodos. Al aplicar: "Ajuste aplicado.", una línea en mono (`formatTuneSummary`, clase
    `.tune__summary`) "Fidelidad 86,8 % → 86,6 % · Esquinas 79 → 3 · Nodos 1218 → 851 · Tamaño 40,2 → 29,6 KB" [ahora en palabras,
    "Fidelidad de 86,8 % a 86,6 % · …", ver "Revisión en el navegador: contornos finos"] y la lista de
    cambios (`.tune__changes`); la puntuación sale del mensaje final (sigue en el progreso). Esquinas = round(cornerFraction ·
    nodeCount), exacto porque nodeCount = líneas + curvas. Espacios no separables dentro de cada tramo: el panel de 320 px
    solo parte entre tramos. La unidad de tamaño se escribe una vez si coincide ("1,02 MB → 980 KB" si no). Ojo: son las
    fidelidades del tuner (render de referencia a 1×), no la del panel medida en el navegador; en pilas de muchas capas salen
    por debajo (eagle 0.8680 frente a 0.9000, ver "Auto-ajuste y comparación").
  · Tablero pintado. Título "Transparencia falsa". `withBakedCheckerboard(avisos, info.bakedBackground, ajuste de la UI)`: el
    aviso sigue al ajuste de la UI y no al último trazado, que llega tarde tras el clic y con 'keep' no avisa. Con detección va
    el primero; en 'auto' con el texto del trazado (o el mismo texto, `transparentCheckerboardMessage`, fijado por test contra
    `bakedCheckerboardWarning`, si el trazado en pantalla era 'keep'); en 'keep' "Se conserva el tablero de ajedrez pintado
    (cuadros de N px) como parte del diseño: se traza y se compara con los píxeles tal cual. Si solo imita la transparencia,
    trátalo como transparente." Acciones "Mantener el tablero" (bakedBackground 'keep') y "Tratar como transparente" ('auto')
    en todos los modos: el modo píxel también traza la fuente efectiva. Control "Fondo de tablero pintado" (Auto · Mantener)
    en Avanzado > Trazado, visible solo con `SourceInfo.bakedBackground` (campo nuevo `ControlContext.bakedBackground`), con
    la nota "Detectado: cuadros de N px.". `DEFAULTS` incluye el ajuste, así que `sameTrace` lo distingue y el clic re-traza.
  · Conservar el tablero en Líneas/logo no sirve: el modo emite un solo relleno y la UI manda el modo detectado sobre la
    fuente efectiva (un logo de un color sobre transparencia es 'lines'). Medido en la app compilada (Chromium) con un tablero
    de 256 px, cuadros de 16 px #ffffff / #cccccc, disco y barra magenta: transparente 99,9 % (41 nodos, 1,4 KB); lines + keep
    32,9 % (disco gris sin tablero, 81 nodos, 2,6 KB); flat + keep 99,6 % (923 nodos, 12,2 KB, el tablero vectorizado). Por
    eso, con el modo de la UI en líneas, la acción es "Mantener el tablero en Color plano" (keep + mode 'flat'), la opción
    Mantener del control queda deshabilitada con el motivo "Líneas/logo traza un solo color: para conservar el tablero cambia a
    Color plano." y, si se llega igualmente a lines + keep (conservar en plano y volver a Líneas), el aviso lo explica y ofrece
    "Tratar como transparente". Aviso y acción usan el modo elegido en la UI, no el del trazado en pantalla, que llega tarde.
    Se descartó mandar Auto al trazador con 'keep' para que clasifique los píxeles conservados: la UI no tendría ni el modo
    detectado ni sus motivos para los controles, y el protocolo no permite clasificar con 'keep'.
  · Vista previa: `setSource(image, { original, result })` y `setResultAlpha(bool)`. Original = píxeles reales: con detección
    `info` describe la fuente efectiva, así que su transparencia se lee de los píxeles (alpha < 248, el corte de SourceInfo).
    El panel SVG pinta el tablero de la UI (cuadros de 8 px) si la fuente tiene alpha, o si hay tablero detectado y el trazado
    en pantalla no lo conservó; se actualiza con cada SVG mostrado.
  · 'empty-trace' en líneas: si el mensaje propone "Transparencia: Máscara" (`suggestsAlphaMask`; las tres causas comparten
    código y solo el texto las distingue, así que el test lo comprueba con el `prepareLines` real) y la transparencia no está
    ya en máscara, la acción es "Usar máscara de transparencia" (alphaMode 'mask'); si no, "Cambiar a Color plano". La opción
    del select Transparencia pasa a "Máscara (el canal alfa es la tinta)" para que lo que dice el aviso se encuentre.
  · JetBrains Mono ya entraba por `@import` en `src/styles/app.css`: `src/main.ts` no cambia (el build emite sus 5 woff2).
  · Comprobado en la app compilada (`vite preview`, Chromium, imágenes sintéticas soltadas con un evento drop). Tablero de
    256 px (Líneas/logo detectado): aviso con "Mantener el tablero en Color plano", Original sin el tablero de la UI y SVG con
    él; tras el clic, Color plano + keep, 99,6 %, SVG sin tablero de la UI. Ajuste automático sobre ese estado: "Fidelidad 99,5 %
    → 99,6 % · Esquinas 747 → 855 · Nodos 923 → 1204 · Tamaño 12,2 → 18,8 KB" en JetBrains Mono, partido solo entre tramos
    (el ajuste cambia esquinas por fidelidad en un tablero de cuadrados, de ahí "equilibrio"). Estrella blanca sobre
    transparencia con Transparencia: Componer: SVG de 94 B sin nodos y aviso con "Usar máscara de transparencia"; tras el clic,
    Máscara, 87 nodos, 100,0 % y sin avisos. Main chunk 74 262 B (gzip 26 318; antes 72 160 / 26 078), sin pipeline ni tuner.

- Revisión en el navegador: contornos finos, formas claras sobre el tablero, franja AA, falsos tableros y avisos
  (`src/core/palette.ts`, `src/core/bakedBackground.ts`, `src/ui/warningsView.ts`, `src/ui/tuneProgress.ts`, `src/ui/app.ts`,
  `src/styles/layout.css`, `tests/fixtures/shapes.ts`), 2026-09-10. Fallos vistos al probar la app con imágenes reales y
  sintéticas; cada uno tiene su test que fallaba antes del arreglo.
  · Paleta: excepción de rasgo distinto a la coherencia espacial (`DISTINCT_DISTANCE` = 60 ponderado, `MIN_STRUCTURE_SHARE` =
    0.5), en exactPaletteDetailed y en consolidatePalette. Un cluster sin núcleo suficiente sobrevive si su mayor pieza
    8-conexa tiene >= max(12 px, 50 % de sus píxeles) y su centro está a >= 60 de todo cluster coherente. Antes un contorno de
    <= 2 px (ningún píxel con 8 vecinos de su color) salía de la paleta, una pegatina amarilla con aro oscuro se quedaba en 2
    colores, classify elegía 'lines' y el aro se pintaba amarillo (revisión: fidelidad sobre blanco 0.6989 con 1.5 px y 0.6867
    con 2 px; sobre transparencia 0.8998 / 0.8761 / 0.8600 con 1 / 1.5 / 2 px). Medido ahora con `ringedDisc` (trazado auto,
    potrace, fidelidad sobre blanco; aro = píxeles cubiertos del todo que salen oscuros):

    ```
    aro      opaco: paleta modo fidelidad aro          transparente: paleta modo fidelidad aro
    1 px     3 flat 0.9869 16/16                      2 flat 0.9974 16/16
    1.5 px   3 flat 0.9869 96/96                      2 flat 0.9978 96/96
    2 px     3 flat 0.9874 276/276                    2 flat 0.9966 276/276
    3 px     3 flat 0.9858 572/572                    2 flat 0.9958 572/572
    ```

    Icono de 48 px con disco navy y punto rojo de radio 2.5 (16 px, 4 de núcleo): paleta 3, 'flat', capa #dc1e28, centro del
    punto (220,30,40), fidelidad 0.9877 (antes 'lines' y el punto navy; el suelo anterior del 0.5 % lo guardaba hasta ~56 px de
    lado). Separación medida: ringing de clip_art (190,20,104) a 21-22 del magenta y banda sintética de 1 px a 34 (se siguen
    descartando); remanente pálido de clip_art efectivo (253,226,248), 130 px en 38 piezas (la mayor de 28) a 99: se descarta
    por fragmentado; aro de 1.5 px, una pieza a 221; punto rojo, una pieza a 101 del navy. Paletas de las muestras idénticas
    (GENTERA 6, clip_art efectivo 2 y con tablero 3, avatar 3, splash con tablero 7; Instagram, eagle y splash efectivo null).
    El centro k-means de un rasgo fino se desplaza hacia su antialiasing con o sin la regla (aro de 1.5 px en consolidatePalette:
    (55,52,36)). Tests cambiados: el bloque rojo de 5×5 del test de coherencia sobrevive como rasgo distinto y el mismo bloque en
    (60,20,20), a 37 del negro, no; con minCoreRatio 0.99 el cuadrado negro queda como rasgo distinto. Sigue sin distinguirse
    un contorno que es un tono de su relleno (a < 60): se descarta como el ringing.
  · Tablero pintado: formas claras que lo tocan (`reconstructLightShapes`). Una forma blanca, o gris del nivel del tablero,
    4-conexa con él cae en su componente de borde; se devolvían solo los infractores gruesos (sobre celdas del otro nivel) y las
    mitades sobre celdas de su mismo nivel quedaban transparentes, en damero. Barra de 3 840 px sobre celdas de 16 px: 2 160 px
    de fondo (1 920 de su paridad y 240 de infractores de 4 px de alto, que no aguantan 2 erosiones), SVG con 2 160 px con alpha
    < 128 y fidelidad contra la verdad 0.9867 sobre blanco (el blanco tapa los huecos) y 0.7732 sobre negro. Ahora cada píxel
    de una celda oculta pertenece a la forma según los píxeles de la forma a 1-2 px fuera de sus bordes, en su fila (L, R) y en
    su columna (U, D): L && R, U && D o (L || R) && (U || D), exacto para bordes y esquinas alineados con los ejes (un borde curvo
    se aproxima dentro de la celda; una celda oculta en el extremo de una forma sin apoyo en la otra dirección sigue siendo
    fondo, no hay evidencia). Los infractores finos 4-adyacentes a la forma se unen y se repite, hasta 4 rondas. Medido con
    niveles 255/204 (barra 255 y 204) y 238/255 (barra 238 y 255): 0 px de la barra en el fondo, 0 px de tablero a >= 2 px de
    lo opaco conservados, SVG sin huecos, fidelidad contra la verdad 0.9938-0.9973 sobre blanco y 0.9922-0.9926 sobre negro
    (pctDiff16 0.016-0.017). clip_art y splash: fondo 87.06 % y 81.57 %, como antes.
  · Franja AA con residuo (`FRINGE_MAX_RESIDUAL` = 32, RGB crudo). La tinta de un píxel de franja es el píxel opaco no fondo de
    su 5×5 más lejano de L cuya mezcla con L lo explica, |P − (L + a (I − L))| <= 32 con a recortado a [0, 1] (P mismo vale, con
    a = 1); si nada lo explica el píxel queda intacto. Antes era el más lejano sin comprobar nada: junto a un contorno oscuro un
    amarillo proyectaba a 0.25-0.6 y se repintaba como tinta oscura translúcida, o se borraba con a <= 0. Sprite de 24 px con
    contorno de 1 px sobre celdas de 8: 84 de 576 píxeles alterados y 6 paths con fill-opacity en píxel exacto → 0 y 0;
    pegatina con aro de 1 px: 222 píxeles amarillos → 0 de 7 376; el test de la franja (bakedCheckerLogo) sigue estimando alpha
    en > 50 píxeles. Muestras, con la máscara actual y la estimación anterior frente a la nueva: clip_art 3 949 translúcidos y
    166 borrados frente a 3 741 y 161 (213 píxeles quedan opacos); splash 9 158 y 812 frente a 9 106 y 535 (329 opacos);
    translúcidos con residuo > 48: 0 en las dos (la revisión contó 80 y 123). Los 476 píxeles de splash que acaban
    transparentes lejos (> 48) de los dos niveles de borde están a <= 32 de su nivel local (el brillo pintado sobre el
    tablero): no son tinta.
  · Detección: celdas del borde (`borderCellsAgree`). La banda de 3 px no distingue rayas a 45° (voltean como un tablero a lo
    largo de las bandas superior e izquierda y solo discrepan cerca de las esquinas lejanas: ratio 0.92-0.93) ni vichy gris
    255/230/205 (paridad perfecta en un anillo de celdas pares; las cruces más oscuras no son candidatas). Ahora, en los dos
    anillos exteriores de celdas (interior a 2 px de sus bordes, celdas de >= 9 px), >= 95 % (`CELL_PARITY_MATCH`) de los
    píxeles neutros a +-8 de un nivel deben mostrar el de su paridad (rayas 0.66-0.87 en dos anillos, 0.69-0.91 en uno;
    tableros reales 1.000 en fixtures, clip_art y splash), y las dos clases de celdas de cada paridad ((par, par) con (impar,
    impar), (par, impar) con (impar, par)) deben tener la misma mediana de celdas uniformes (>= 80 % a +-8 de su mediana) a
    +-16 (vichy 200×150 celda 12: un anillo no ve ninguna celda (impar, impar); con dos, 255 frente a 205; la proporción de
    celdas uniformes que coinciden con su nivel, 0.769, se descartó como criterio porque splash da 0.911). Barrido de 180
    rayas (4 tamaños × 15 anchos × 3 pares de niveles): 30 detectadas → 0; vichy, 4 casos: 3 → 0. clip_art y splash: misma
    celda, offsets y niveles; detección 2.4 y 5.6 ms.
  · Bench (potrace; fidelidad frente a la fuente efectiva), antes → después:

    ```
    image                 dims       mode  U  layers  paths  nodes  corner  naive  bytes    fidel  ssim   iou    mae  pct16  warnings
    GENTERA               1561x1672  flat  2  6       9      1853   0.012   0.095  70527    0.999  1.000  0.999  0.0  0.001  -
    Instagram             3840x2160  flat  1  12      4477   60446  0.020   0.020  2391810  0.940  0.991  0.862  1.6  0.138  photo
    clip_art              290x193    flat  4  2       55     678    0.080   0.085  22664    0.960  0.993  0.910  1.2  0.090  baked-checkerboard
    eagle                 350x350    flat  4  14      316    22702  0.042   0.057  772116   0.900  0.983  0.776  2.9  0.224  photo
    Compartamos avatar    800x800    flat  2  3       44     1027   0.167   0.302  33362    0.995  0.999  0.988  0.2  0.012  -
    splash                740x740    flat  2  16      2675   36945  0.058   0.068  1268085  0.897  0.950  0.818  2.6  0.182  baked-checkerboard,photo
    ```
    GENTERA, Instagram, eagle y avatar idénticos (consolidatePalette no cambia las fotos). clip_art 0.961 → 0.960 (IoU 0.913 →
    0.910, 46 → 55 paths, 612 → 678 nodos) y splash 0.899 → 0.897 (IoU 0.816 → 0.818, 34 870 → 36 945 nodos): los 213 y 329
    píxeles de franja que ninguna mezcla explica quedan opacos. Dentro de las holguras; suelos `MEASURED` sin cambios.
  · Avisos y foco (`warningsView`). `set()` reconstruía todos los banners con `replaceChildren` cuando cambiaba un código,
    mensaje o etiqueta; la acción del tablero es un interruptor que cambia su propio mensaje y etiqueta en el mismo clic
    (changeParams → refreshWarnings, síncrono), así que el botón enfocado salía del DOM y el foco caía en <body>. Ahora los
    banners se indexan por código y se actualizan en su sitio (título, texto, botón y acción); solo se mueven nodos si cambia el
    orden de los códigos, y si el foco estaba en un banner y se ha perdido vuelve a la acción de ese código (o a la primera
    acción que quede). Test con un DOM mínimo que modela el paso del foco a <body> al quitar o mover el elemento enfocado.
    Medido en Chromium (servidor de desarrollo, tablero de 256 px con disco y barra magenta): botón enfocado "Mantener el
    tablero en Color plano", clic → `activeElement` es el mismo botón, conectado, con "Tratar como transparente"; clic otra
    vez → el mismo botón con "Mantener el tablero"; sigue enfocado tras el re-trazado.
  · Ajuste automático: resultado caducado (`tuneResultOutdated`, `ShownTuneResult`). La app recuerda para qué parámetros se
    mostró el mensaje del ajuste ("Ajuste aplicado." con su resumen y cambios, el de cancelado o el de error) y changeParams lo
    borra en cuanto `sameTrace` deja de coincidir; los ajustes de salida (optimize) no lo borran. Medido en Chromium: tras
    aplicar el ajuste y cambiar Modo a Líneas/logo, `.tune__result` pasa a oculto en el mismo clic y sigue oculto tras el
    re-trazado (fidelidad del panel 99,4 % → 99,8 %).
  · Avisos por debajo de 760 px: `.banner__body { flex-basis: calc(100% - 40px) }` y `.banner__action { margin-left: 28px }`
    (icono de 18 px y hueco de 10) dentro del media query. `flex: 1` computa a `1 1 0%`: con base 0 el `flex-wrap: wrap` solo
    partía si icono, huecos y acción no cabían, cosa que con estas etiquetas no pasa nunca. Con base casi del 100 % el texto
    ocupa la primera línea tras el icono y la acción baja, alineada con el texto; los 12 px de holgura evitan que un ancho de
    icono fraccionario mande el texto a la segunda línea. `tests/ui/layout.test.ts` reproduce el reparto de líneas del flex a
    partir de las declaraciones (343, 520, 700 y 759 px). Medido en Chromium con el aviso del tablero: 375 px, texto de 71 → 263
    px, 16 → 8 líneas, aviso de 363 → 236 px de alto; 700 px, 341 → 588 px y 5 → 3 líneas; 759 px, 455 → 647 px; en los tres
    la acción queda en su línea con el borde izquierdo del texto y sin scroll horizontal.
  · Cifras pendientes de medir: `.fidelity.is-stale` y `.metric__value.is-stale` usaban `opacity: 0.55` y el test de contraste
    solo miraba pares a opacidad 1 (en claro la cifra en aviso quedaba en 2.33:1 y los valores en 3.99:1). Ahora la cifra y
    los valores pasan a `muted` y el punto a `line-strong`, sin opacidad; las reglas de la cifra y el punto van después de las
    de nivel, con la misma especificidad, y un test lo exige. El test compone cada parte del estado `is-stale` con la opacidad
    y el color que declaren sus reglas. Medido en Chromium con elementos de prueba sobre el panel: opacidad 1; cifra 5.88:1
    en claro y 6.02:1 en oscuro para ok, aviso, error y sin nivel; punto 3.02 y 4.09; valores 5.88 y 6.02; texto de nivel
    17.85 y 14.71.
  · Resumen del ajuste en palabras: "Fidelidad de 86,8 % a 86,6 % · Esquinas de 79 a 3 · Nodos de 1218 a 851 · Tamaño de 40,2
    a 29,6 KB" ("de 1,02 MB a 980 KB" si cambia la unidad). U+2192 no está en ningún subconjunto de @fontsource-variable
    (comprobado leyendo el cmap de los woff2 de JetBrains Mono: el latino trae U+2191 y U+2193 pero no U+2192), así que la
    flecha salía de la mono de reserva. Se descartaron "›" y "»" (entre números se leen como "mayor que") y "->" (depende de la
    ligadura). Test: cada carácter de la línea está en un unicode-range de la cara normal. En Chromium: "Fidelidad de 99,6 % a
    99,4 % · Esquinas de 6 a 0 · Nodos de 50 a 13 · Tamaño de 1,7 KB a 600 B". La lista de cambios (Manrope, "Suavizado: 1,00
    → 1,15") conserva la flecha: Manrope tampoco la trae, queda fuera de esta revisión.

- Degradados, fase 0: contrato, esqueleto del modo y fixtures (`src/types.ts`, `src/core/fillEval.ts`, `src/core/params.ts`,
  `src/core/pipeline.ts`, `src/tuner/autotune.ts`, `src/dev/synth.ts`, UI), 2026-09-11. Lines, flat y pixel sin cambios.
  · Salida idéntica byte a byte, comprobada contra una copia de HEAD (`git archive`, con un canario que confirma que esa copia no tiene
    DEFAULTS.gradient): sha256 del SVG, stats y avisos de trace() en 8 fixtures (aaCircle, aaDiagonalLine, glyph, flatShapes3, sprite32 ×4,
    transparentLogo, noisePhoto, bakedCheckerLogo) × auto/lines/flat/pixel × potrace/vtracer × stacked/cutout (128 trazados), más autotune
    con reloj falso en glyph y flatShapes3 (svg, puntuación, evaluadas y params): 130 líneas idénticas. Bench real: tabla abajo.
  · `traceLayers`, `isFullMask` y `rectPath` se exportan de pipeline y se borró su copia de autotune.ts; la preparación por modo es una sola
    función, `prepareForMode`, que usan trace() y el tuner. `PreparedLayer.mask` admite una función (máscara perezosa) y todo lector pasa
    por `layerMask` (31 lecturas directas cambiadas en los tests).
  · [Sustituido en la fase 6: el fallback solo se usa con edgeShare > 0.6 o más de 2000 regiones.] `prepareGradient` es hoy el fallback: prepareFlat con 16 colores median cut (exactPalette false; la capa resuelta, 'cutout' por defecto)
    más 'gradient-fallback' ("No se pudieron reconstruir los degradados. Se vectorizó como Color plano con 16 colores y pueden verse bandas
    de color."). Medido: trace(flatShapes3(96), { mode: 'gradient' }) da 3 capas (a ≤ 8 niveles de la paleta), ese aviso y ningún `url(`.
  · fillEval: `DEGENERATE_EPS` = 1e-6 (|d| y r) y `DEGENERATE_COLOR_SPAN` = 1 nivel, los del encargo. `normalizeStops` recorta colores a
    [0, 255] sin redondear (el hex del SVG redondea: ≤ 0.5 niveles entre el rasterizador y el navegador) y deja una sola parada, la
    posterior, cuando dos comparten offset (la rampa pierde ese salto duro). t con NaN → 0; geometría degenerada → t = 1 (última parada,
    como SVG). Test de convención: para U ∈ {1, 2, 4}, scaleGradient(g, U) en (X + 0.5, Y + 0.5) = g en ((X + 0.5)/U, (Y + 0.5)/U) a < 1e-9.
  · Parámetros: `regionDetail` [0.5, 2] (defecto 1), `maxStops` entero [2, 8] (defecto 8), `radialGradients` true solo si es true (la regla
    de opticurve). Defaults en los 4 modos (ModeDefaults los exige; `PARAM_KEYS` de la UI los recoge: diffParams de flat a gradient =
    ['mode', 'layering']). DEFAULTS.gradient = base + layering 'cutout'.
  · UI mínima: "Degradados" entre Color plano y Píxel exacto (el control Modo pasa de 4 a 5 segmentos: la fase 8 debe comprobar su ancho en
    el panel de 320 px); Capas visible en flat y gradient; 'gradient-fallback' con título "Degradados no reconstruidos" y acción "Cambiar a
    Color plano"; empty-trace en gradient ofrece "Quitar manchas mínimas" como en flat. Build: index-*.js 75.48 kB (gzip 26.80),
    trace.worker-*.js 177.07 kB.
  · gradientFeathers (geometría exacta en su comentario):
    - Una primera versión con cometas de vértices agudos (10.8° en la punta) daba etiquetas argmax partidas: plumas 2, 3, 6 y 7 en 3-4
      piezas por astillas subpíxel. Con base y punta romas de 3 px, una pieza por etiqueta a 128 y 256 px (semillas 1-3 en el test, 1-8
      medidas).
    - Plumas 3 y 4: con sus bases sobre el arco los lados se solapaban 2.94 px y dejaban una astilla de la 3; ahora las bases están a
      ±1.47 px (1.5·cos 11.25°) de la recta compartida y los lados coinciden. 44 pares 4-adyacentes; diferencia mínima entre las rampas en
      el contacto 33.5-36.1 niveles (semillas 1-8; semilla 1: 35.7). El test exige ≥ 40 pares y ≥ 33 niveles: el contacto nunca llega a
      t = 0.5, donde azul → púrpura y púrpura → azul coinciden.
    - Hueco entre plumas vecinas no contiguas 4.1 px (7.5 px junto al par 3/4); nada a menos de 3 px del borde. Áreas a 256 px (semillas
      1-8): plumas 774-967 px, sombra 380 px, fondo ≈ 57 900 px. Tiempo: 32 / 99 / 373 ms a 128 / 256 / 512 px.
    - A 512 px (solo `?synth=gradient`) la etiqueta del fondo tiene 2 piezas: una mota en la cuña fina donde se separan 3 y 4.
    - Pintado sin conflation (cobertura efectiva = submuestras cuya forma superior es esa): componiendo coberturas independientes como
      flatShapes3, un lado compartido deja ver el fondo, f·(1 − f), hasta un 25 % de blanco en la costura, que regalaría el borde entre 3 y
      4. Cada relleno se evalúa en el centro del píxel: un píxel interior es exactamente round(relleno) (test: > 90 % de los píxeles son
      interiores, con diferencia ≤ 1 y su etiqueta).
  · hueRamp: #ed2b2b y #149e14, de una búsqueda exhaustiva de rojos (R 200-240, G y B ≤ 70) y verdes (G 130-200, R y B ≤ 70) con
    299R + 587G + 114B idéntico: luma 101.006 en ambos; tras redondear, |luma − 101.006| ≤ 0.5 en todos los píxeles.
  · withNoise: entero uniforme en [−amp, amp] por canal e independiente (como el ruido de bakedCheckerLogo). amp 3: σ 2 por canal (test
    2 ± 0.05 en 64×64) y 0.669·2 = 1.337 en luma. Immerkær sobre la luma SIN excluir bordes, semillas 1-3: gris plano y hueRamp
    1.345-1.360, noisePhoto(256) 1.356-1.372, diagonalSweep 1.313-1.339, gradientFeathers 1.710-1.720 (limpio 0.979), flatShapes3
    1.766-1.806 (limpio 0.480), radialDisc 1.933-1.962 (limpio 1.069). Para la fase 1: "ruido ±3 → σ̂ ∈ [1.4, 2.1]" no se alcanza sobre
    contenido plano con un estimador correcto (≈ 1.34); no se cambió el ruido para encajar ese umbral.
  · Bench (potrace): `samples/pajaro.png` (4001×4001) entra en NAMES como 'pajaro' con fila MEASURED medida con el pipeline actual
    (clasificado flat con 19 colores exactos, offPaletteRatio 0.015, hardEdgeRatio 0.415, borderColor [0, 0, 0], sin aviso photo: el plan
    esperaba foto y fondo blanco; la fase 7 actualiza la fila). Filas antes → después, idénticas salvo ms:

    ```
    image                            dims  mode   U      ms  layers  paths   nodes  corner  naive     bytes  fidel   ssim    iou    mae  pct16  warnings
    antes (pajaro medido con la fila aún sin nombre ni MEASURED):
    GENTERA                     1561x1672  flat   2     978       6      9    1853   0.012  0.095     70527  0.999  1.000  0.999    0.0  0.001  -
    Instagram                   3840x2160  flat   1     886      12   4477   60446   0.020  0.020   2391810  0.940  0.991  0.862    1.6  0.138  photo
    clip_art                      290x193  flat   4      96       2     55     678   0.080  0.085     22664  0.960  0.993  0.910    1.2  0.090  baked-checkerboard
    eagle                         350x350  flat   4     344      14    316   22702   0.042  0.057    772116  0.900  0.983  0.776    2.9  0.224  photo
    Compartamos avatar            800x800  flat   2     272       3     44    1027   0.167  0.302     33362  0.995  0.999  0.988    0.2  0.012  -
    pajaro.png                  4001x4001  flat   1    2084      19   9767   46022   0.048  0.050   1891025  0.981  0.996  0.959    0.8  0.041  large-input
    splash                        740x740  flat   2     383      16   2675   36945   0.058  0.068   1268085  0.897  0.950  0.818    2.6  0.182  baked-checkerboard,photo
    después:
    GENTERA                     1561x1672  flat   2     991       6      9    1853   0.012  0.095     70527  0.999  1.000  0.999    0.0  0.001  -
    Instagram                   3840x2160  flat   1     951      12   4477   60446   0.020  0.020   2391810  0.940  0.991  0.862    1.6  0.138  photo
    clip_art                      290x193  flat   4      93       2     55     678   0.080  0.085     22664  0.960  0.993  0.910    1.2  0.090  baked-checkerboard
    eagle                         350x350  flat   4     341      14    316   22702   0.042  0.057    772116  0.900  0.983  0.776    2.9  0.224  photo
    Compartamos avatar            800x800  flat   2     271       3     44    1027   0.167  0.302     33362  0.995  0.999  0.988    0.2  0.012  -
    pajaro                      4001x4001  flat   1    2087      19   9767   46022   0.048  0.050   1891025  0.981  0.996  0.959    0.8  0.041  large-input
    splash                        740x740  flat   2     386      16   2675   36945   0.058  0.068   1268085  0.897  0.950  0.818    2.6  0.182  baked-checkerboard,photo
    ```

- Degradados, fases 1 y 2: ruido, bordes y regiones (`src/core/noise.ts`, `src/core/edges.ts`, `src/core/regions.ts`), 2026-09-11.
  · `immerkaerSigma`, exclusión de bordes: `EDGE_SOBEL_MIN` = 24 (el suelo Sobel de la segmentación) y `EDGE_SOBEL_PER_SIGMA` = 3; opaco =
    alpha ≥ 250 en todo el 3×3; la exclusión se dilata al 3×3. σ̂ sin exclusión / con T = 16 / con T = 24:
    ```
    fixture                   sin excl.  T16    T24
    flatShapes3               0.480      0.000  0.000   (conserva el 87 %)
    flatShapes3 ±3            1.806      1.378  1.378
    gradientFeathers(256)     0.979      0.010  0.011   (87 %)
    gradientFeathers ±3       1.720      0.794  0.796
    radialDisc                1.069      0.092  0.092
    diagonalSweep             0.410      0.162  0.162
    noisePhoto(256)           0.201      0.199  0.200   (conserva 19 % a T8, 75 % a T16, 97 % a T24)
    pajaro 2× (2001²)         0.150      0.015  0.016
    pajaro 8×                 0.515      0.015  0.018
    ```
    Rampa empinada (8 niveles/px) con ±3: T16 conserva 0-2 % de los píxeles y oscila entre 0.78 y 1.43; T24 conserva el 100 % y lee
    1.27-1.43. 41-59 ms a 2001×2001. Objetivos del plan que un estimador correcto no alcanza (los tests fijan lo medido más estrecho):
    "ruido ±3 → σ̂ ∈ [1.4, 2.1]": la luma da 0.669·2 = 1.337 en teoría, medido 1.340-1.382 en gris plano, hueRamp, flatShapes3 y
    noisePhoto (semillas 1-3), test [1.33, 1.40]; en gradientFeathers 0.787-0.796 porque el blanco satura la mitad del ruido.
    "noisePhoto > 3": es un campo bilineal suave, 0.199; test [0.15, 0.25] y ruido ±10 > 3.
  · Bordes en gradientFeathers(256): edgeShare 0.1187 / 0.1184 / 0.1173 (semillas 1-3), con ±3 0.1185-0.1187; regionDetail 0.5 → 0.1055,
    2 → 0.1277; 0.2055 a 128 px y 0.0610 a 512 px. Laplaciano dentro de las plumas (≥ 3 px Chebyshev de cualquier contorno): media
    0.356, p99 0.5, máximo 0.75 (a 2 px del contorno llega a 9, alcance del AA); con ruido media 0.81 y máximo 1.875; todo bajo lapLo 2.7.
    "Laplaciano < 0.5 en el interior" se cumple para la media (0.356-0.359), no para el máximo (doble redondeo: fixture y salida Uint8 del
    desenfoque): test media < 0.5 y máximo ≤ 0.75. Plumas 3/4: los 44 pares de contacto son borde por ambos lados y ningún 4-camino de no
    borde une las dos plumas. radialDisc edgeShare 0.368 con 2 regiones; diagonalSweep 0.091 con 2; hueRamp 0 con 1; noisePhoto 0.931
    con 370 regiones (dispara el fallback de 0.6). Máscara de bordes = hysteresis(laplaciano) ∪ hysteresis(Sobel), dos pasadas separadas.
  · `segmentRegions` NO usa los anillos de mayoría de `growIntoBand` (implementada tal cual y con tests): la banda se rellena por color
    (`growByColour`, privada: crecimiento con semillas sobre el RGB sin desenfocar, prioridad |ΔR| + |ΔG| + |ΔB| entre 4-vecinos, cola de
    `COLOUR_BUCKETS` = 766 cubetas FIFO dentro de cada prioridad, el píxel toma la etiqueta del 4-vecino etiquetado de color más parecido,
    empate → id menor); los elegibles que no alcanza ninguna región forman componentes 4-conexas nuevas, como en el contrato. `BAND_RINGS`
    sigue exportada sin uso. Motivo, gradientFeathers(256), semillas 1-5, limpio y ±3: los anillos daban puntas y bases de pluma al fondo,
    122-132 regiones con 98-109 sin núcleo e IoU de la peor pluma 0.905-0.922 incluso fusionando fragmentos; el color da 23-28 regiones,
    todas con núcleo, IoU 1.000 en todas las formas (semillas 1-3 limpias, tras fusionar) y 0.935 la peor con ruido. L1, máximo por canal y
    L2 ponderada por luma dieron la misma IoU con semillas limpias; se eligió L1. Con transparencia el predesenfoque corre sobre color
    premultiplicado y se despremultiplica, como prepareFlat.
  · Regiones crudas de gradientFeathers(256), color / anillos: semillas 1-3 23 / 23 / 24 (126 / 132 / 130, 103 / 109 / 106 sin núcleo);
    ±3: 26 / 26 / 28; regionDetail 0.5 / 1 / 2: 21 / 23 / 39; a 512 px 11 (10 de ≥ 320 px); a 128 px 18; 7-27 ms a 256 px. "10 ± 1
    regiones de ≥ 16 px" no se cumple sobre la salida cruda con la definición de núcleo del contrato: quedan 13-14 fragmentos de 1-10 px de
    núcleo en puntas, bases y el hueco de 7.5 px junto a 3/4, que crecen a ≥ 16 px (18 / 18 / 19 crudas de ≥ 16 px). El test de regions
    aplica un sustituto documentado de planMerges (fusiona planas adyacentes con sd ≤ 4 y medias a ≤ 6; una región con < 16 px de núcleo
    va al vecino de color más cercano): 10 regiones, IoU ≥ 0.97 (medido 1.000); con ruido 10-11 y mejor IoU por forma ≥ 0.93 (peor 0.935).
    En el pipeline las fusiona planMerges (fase 6: 11 capas).
  · `regionOrder`: la regla de contención (una región cuyo único vecino es a va después de a) solo se aplica si la región no toca el borde
    de la imagen; sin esa condición un fondo cuyo único vecino es un anillo se pintaría después del anillo. En un ciclo (dos regiones que
    solo se tocan entre sí, aisladas por transparencia) la primera por área conserva su sitio.
  · `refineLabels`: suma sin ponderar sobre R, G y B (la del contrato, no los pesos de palette.colorDistance2); empate → la etiqueta del
    píxel (x, y) y después el id menor. Con los rellenos verdaderos sobre la segmentación cruda (cada región con la forma mayoritaria):
    100.000 % de acuerdo fuera de la banda AA a U = 2 y a U = 4 (99.54 / 99.47 % en total), igual con ruido; 2-8 ms por llamada.
    `regionMask` cutout = distancia city-block ≤ dilate dentro de la caja de la región (test: igual a dilate1 aplicado k veces, k = 0..3;
    desde la fase 6, además, ∩ rango ≥ j).
  · pajaro (opaco), proxy 2× por caja (2001²): σ̂ 0.0164, edgeShare 0.0249, 51 regiones y 0 sin núcleo (anillos: 851 y 800 sin núcleo);
    el fondo es el 86.5 % de los píxeles; 32 regiones de ≥ 320 px cubren el 99.98 % de los opacos y el 99.83 % de la tinta, 34 de ≥ 80 px
    (2e-5·W·H) el 99.86 %, 46 son de ≥ 16 px. regionDetail 0.5: 47 regiones (30 de ≥ 320 px), edgeShare 0.0222; 2: 54 (32), 0.0269.
    segmentRegions 375-503 ms: σ̂ 59, predesenfoque 173, mapas 49, histéresis 11 + 11, labelComponents 31, crecimiento por color ≈ 35,
    adyacencia 11. Memoria por encima de la imagen de entrada: pico ≈ 46 MB (copia desenfocada y los dos mapas de 16 MB a la vez), ≈ 38 MB
    en la histéresis, ≈ 31 MB etiquetando; la Segmentation devuelta retiene 22.9 MB (regions Int32 15.3, edge 3.8, core 3.8); con
    transparencia ≈ 15 MB más por la copia premultiplicada. Con el proxy del plan (f = ceil(sqrt(W·H/4e6)) = 3 para 16.008 Mpx, no 2):
    1334², σ̂ 0.019, edgeShare 0.0371, 56 regiones (46 ≥ minArea, 32 ≥ 320 px), 159 ms.
  · Muestras reales (proxy del plan; regiones color / anillos; edgeShare): GENTERA 6 / 17, 0.012; Instagram (f = 2) 8 / 561, 0.048;
    clip_art 291 / 339, 0.341; eagle 287 / 501, 0.633 (fallback); avatar 39 / 622, 0.075; splash 981 / 1566, 0.303.

- Degradados, fase 3: modelos de relleno (`src/core/fillModel.ts`), 2026-09-11. Firmas del contrato; exporta además las constantes de la
  firma, `MICRO_PER_BIN` y `PRUNE_MAX_RMSE_LOSS`. `tests/fixtures/segFromLabels.ts` exporta segFromLabels, immerkaerOnCore (σ̂ sobre píxeles
  cuyo 3×3 entero es núcleo de una región), regionMapFromLabelMap, labelsFromSdf y singleRegion.
  · Escalera como el plan: `MIN_MODEL_CORE` 64; sólido si rmseFlat ≤ max(2, 1.5σ̂); degradado aceptable si rmse ≤ max(2.5, 2σ̂) y
    ≤ 0.6·rmseFlat; radial además ≤ 0.85·rmseLin. Douglas–Peucker ε = max(1.5, 0.8σ̂) con distancia RMS sobre R, G, B en el parámetro del
    vértice (la unidad del RMSE). Extensión de la rampa = percentiles 0.5 y 99.5; K = clamp(round(L/4), 8, 64); vértice de un bin =
    parámetro y color medios ponderados, no el centro del bin. IRLS 2 pasadas Tukey con c = 4.685·max(1.4826·MAD, `TUKEY_MIN_SCALE` 1
    nivel): sin el suelo, en imágenes limpias (MAD ≈ 0.25) cualquier píxel a más de 1.7 niveles pesaba 0.
  · Colores de parada: mínimos cuadrados ponderados de la rampa lineal a trozos sobre los píxeles (base de sombreros, sistema
    tridiagonal), así que los extremos no necesitan regla de extrapolación. Refinado de nudos (añadido): `MICRO_PER_BIN` 16 micro-bins por
    bin guardados como sumas prefijas (cualquier conjunto de nudos cuesta O(nudos)); cada nudo se coloca por búsqueda exhaustiva en esa
    rejilla y después se quita el nudo interior cuya eliminación (recolocando sus vecinos) cuesta menos mientras el RMSE ponderado suba
    ≤ `PRUNE_MAX_RMSE_LOSS` 0.05:
    ```
    fixture         solo Douglas–Peucker                                  con refinado y poda
    radialDisc      4 paradas (0, .449, .553, 1), err 0.83, rmse 1.12     3 (0, .511, 1; codo real 24/46.93 = .511), err 0.02, rmse 0.28
    diagonalSweep   5 paradas, rmse 0.46                                  4 (0, .277, .665, 1), rmse 0.38
    plumas con ±3   una parada espuria en .067 (semilla 2)                2 paradas en 320 de 320 casos (40 semillas)
    ```
    Con 8 micro-bins y sin recolocar vecinos al quitar, radialDisc conservaba 2 nudos (.506 y .517).
  · Centro radial: derivadas con gaussiana σ 0.7 y diferencias centrales solo donde el soporte 9×9 es núcleo de la región (con menos de
    16 muestras, 3×3 sin suavizar); ≤ `RADIAL_MAX_SAMPLES` 8192 muestras; se saltan las de gradiente < `RADIAL_MIN_GRADIENT` 0.05
    niveles/px. `RADIAL_MIN_CONDITION` 0.05; λmin/λmax medido: radialDisc 1.000 (con ruido 0.997), plumas limpias 0.000-0.016,
    diagonalSweep 0.000, hueRamp 0.000, plumas con ruido 0.085-0.691 (al ruido lo rechaza la escalera, no esta prueba).
    `RADIAL_MIN_RADIUS` 2 px; monotonía del canal dominante con tolerancia 2ε (3 niveles en imágenes limpias); el origen de la rampa es 0
    si el percentil 0.5 de ρ queda a menos de un bin.
  · Fusiones: `MERGE_MIN_AREA` = max(16, 2e-5·W·H); `MERGE_MAX_RMSE_GAIN` 1.5; `MERGE_MAX_BOUNDARY_JUMP` 3; `MERGE_MAX_AXIS_DEG` 15. El
    salto es la media, sobre los pares de frontera en el punto medio de sus dos centros, de la mayor diferencia por canal entre los dos
    modelos extrapolados linealmente más allá de sus paradas extremas (sin pad: con pad las dos mitades de una pluma cortada en
    perpendicular a su eje saltaban ≈ 6 niveles, 1.55 niveles/px por ≈ 2 px a cada lado del corte). Ajustes conjuntos = selectModel sobre
    A ∪ B con ≤ `MERGE_MAX_JOINT_PIXELS` 32 768 píxeles núcleo y ≤ `MERGE_MAX_BOUNDARY_SAMPLES` 4096 pares de frontera, por paso uniforme.
    Voraz por coste rmseJoint − max(rmseA, rmseB); destino = mayor área (empate: id menor) y el grupo toma el modelo conjunto.
    Cuantiles: orden exacto hasta 65 536 valores, histograma de 65 536 cubetas por encima. `splitComplex` no está implementada.
  · Sobre segmentaciones verdaderas (segFromLabels): gradientFeathers(256, 1), σ̂ 0.011, borde 4.6 %, 10 regiones en ≈ 8 ms: las 8 plumas
    lineales de 2 paradas, eje a 0.01-0.35°, parada ≤ 0.41 niveles, rmse 0.25-0.33 (plano 12.7-23.3); fondo y sombra sólidos, rmse 0.00.
    Con ±3 (semillas 1-3): todas lineales de 2 paradas, parada ≤ 0.97, rmse 1.76-2.05 (σ̂ 0.79-0.80, no 1.34: domina el blanco saturado).
    radialDisc: radial, centro a 0.00 px (con ruido 0.02), r 46.93 frente a 48 (2.2 %), 3 paradas, err 0.02 (ruido 1.39), rmse 0.28 (ruido
    1.96); diagonalSweep: lineal, eje 0.00°, 4 paradas, err 0.24, rmse 0.38 (con maxStops 2 o 3, como mucho 2 o 3); hueRamp: lineal, eje
    0.00°, 2 paradas, rmse 0.29; flatShapes3: 3 sólidas, rmse 0.00. planMerges: ninguna pareja sobre la verdad; las mitades de las plumas
    5 y 3, cortadas a lo largo o a lo ancho, se fusionan; 3 y 4 nunca; una mota y una línea de 1 px sin núcleo van al fondo; dos rampas a
    20° con límites laxos no se fusionan y alineadas sí ([[1, 0]]); cadena diminuta [[3, 2], [2, 1]].
  · pajaro con la segmentación provisional del agente de la fase 3 (predesenfoque 0.7, laplaciano y Sobel RGB con histéresis, núcleo
    4-conexo, 3 anillos de banda; no la de regions.ts): proxy f = 3, σ̂ 0.211, borde 3.7 %, 609 regiones, 577 fusiones, 32 finales (13
    sólidas, 18 lineales, 1 compleja); RMSE núcleo de la tinta plano 22.40 → modelo 2.83 (todo: 7.67 → 0.97); 90.8 % de la tinta con rmse
    ≤ 2.5; momentos 24 ms, selectModel de 609 regiones 233 ms, planMerges 11 ms, reajuste de 32 regiones 241 ms (fitLinear 128, fitRadial
    64, radial rechazado en 18 de 19). A 4001×4001: σ̂ 0.093, borde 1.3 %, 1458 regiones, 1426 fusiones, 32 finales; tinta 22.77 → 2.77;
    momentos 676 ms, modelos 643, planMerges 40, reajuste 829.

- Degradados, fase 6: `prepareGradient` completo (`src/core/pipeline.ts`, `src/tuner/autotune.ts`; defecto corregido en `regionMask`),
  2026-09-11. Lines, flat y pixel sin cambios: fuera del modo gradient el diff de pipeline.ts solo toca la cabecera y un import, y el
  bench da las mismas filas que en la fase 0 (salvo ms, tabla abajo).
  · Contrato en la firma: `fitGradientRegions` (fondo, proxy f = `gradientProxyFactor` por caja, premultiplicado con transparencia, σ̂,
    segmentRegions, fallback, modelos, ≤ `GRADIENT_MERGE_ROUNDS` 3 rondas de planMerges → mergeRegions → reajuste de las regiones que agrupan
    más de una) y `prepareGradient(img, resolved, info, fit?)`. `GRADIENT_PROXY_AREA` 4e6, `GRADIENT_MAX_EDGE_SHARE` 0.6 y
    `MAX_GRADIENT_REGIONS` 2000 sobre las regiones crudas (el contrato de la fase 6; en los proxies medidos las crudas son ≤ 981). Motivos
    del aviso: "el N % de la imagen es borde" (noisePhoto(64): 94 %, 16 capas planas) y "la imagen se divide en N regiones (el límite es
    2 000)" (celdas de 20 px en 1000²: 2 500). pajaro necesitó 1 ronda (56 → 33 regiones); gradientFeathers(256) 1.
  · refineLabels corre sobre la segmentación del proxy con U·f, como dice el contrato, y no sobre las etiquetas del proxy llevadas a 1× por
    vecino más cercano y refinadas con U: el 3×3 del proxy abarca el error de escalera (hasta f − 1 px a 1×) y la memoria extra es la del
    proxy. pajaro (U 1, f 3, potrace):
    ```
    refinado                                         preparar  trazar   fidelidad  nodos  bytes    arrayBuffers pico
    A: segmentación del proxy, U·f (implementado)    606 ms    1918 ms  0.9956     836    37 492   293 MB
    B: etiquetas 1× por vecino más cercano, U        832 ms    1643 ms  0.9954     1706   71 235   423 MB
    ```
  · La intersección con la máscara alfa de up no se construye aparte: refineLabels da NO_REGION a todo píxel de up con alpha < 128 (el mismo
    corte que maskFromAlpha(up, 0.5)) y regionMask nunca pinta NO_REGION. transparentLogo(64) en gradient: 1 capa, IoU del alfa 0.9929.
  · Defecto de regionMask (tests que fallaban antes del arreglo: gradientFeathers(256) fidelidad 0.9668 < 0.98, con ±3 0.9663 < 0.97, y el
    unitario "cutout never paints over an earlier layer" con 15 píxeles): la dilatación ceil(U/2) de cutout pintaba encima de las capas
    anteriores y engordaba cada forma medio píxel a 1× sobre el fondo. Variantes medidas en gradientFeathers(256), potrace, U 4:
    ```
    capas                                         fidelidad  SSIM    IoU     nodos  píxeles > 16 (todos a 1 px del contorno)
    cutout, dilatación sobre todo (antes)         0.9668     0.9821  0.9439  612    2141
    stacked (rango ≥ j)                           0.9937     0.9988  0.9860  1245   535
    cutout, dilatación solo bajo rangos ≥ j       0.9982     0.9996  0.9963  605    143
    cutout sin dilatar                            0.9982     0.9995  0.9963  608    154
    con ±3: antes / stacked / solo bajo ≥ j       0.9663 / 0.9931 / 0.9977
    ```
    Ahora cutout = dilate_k(rango j) ∩ rango ≥ j: la dilatación queda debajo de las capas posteriores (sin costuras: 0 de 5473 píxeles de
    núcleo con color de fondo) y cada forma conserva su contorno. flat no usa regionMask.
  · Defecto del ajuste (test que fallaba: radialDisc(128) con r/U = 24.91 frente a 48, 2 paradas, fidelidad 0.6871): la histéresis del
    Sobel inunda desde el contorno el anillo de rampa empinada (R 5.5 niveles/px → Sobel ÷4 = 11 > sobLo 9.6), el núcleo se queda en 1976
    de 7256 píxeles (ρ < 24) y la rampa ajustada termina en ρ = 24.9 con pad. Arreglo en el pipeline, no en la segmentación: banda profunda =
    píxeles con alpha ≥ 250 cuyo 3×3 (`GRADIENT_FIT_DEPTH` 1) es todo de su región; una región cuyo núcleo es < `GRADIENT_FIT_MIN_CORE_SHARE`
    0.5 de su núcleo ∪ banda profunda se ajusta también sobre la unión, que gana si no se vuelve compleja y su RMSE sobre el núcleo ≤ el del
    ajuste de núcleo + `GRADIENT_FIT_CORE_TOLERANCE` 0.5 niveles. Medido tras las fusiones (cuota = núcleo / unión; RMSE del ajuste de núcleo,
    entre paréntesis sobre la unión; del ajuste de unión, entre paréntesis sobre el núcleo):
    ```
    caso                                        cuota      ajuste de núcleo               ajuste de unión
    radialDisc, disco                           0.29       radial 0.95 (55.45)            radial 0.28 (0.24)       → unión
    diagonalSweep, cuadrado                     0.96       lineal 0.40 (0.57)             lineal 0.39 (0.31)
    gradientFeathers(256), plumas               0.60-0.78  lineal 0.25-0.32 (0.83-1.54)   lineal 0.25-0.33 (0.23-0.30)
    fragmentos con 2-3 px de núcleo             0.07-0.12  sólido 0.82-2.35 (3.34-5.83)   sólido 2.79-3.93 (2.13-4.70)  → núcleo
    gradientFeathers ×8 bicúbico, proxy 1024²   0.81-0.90  lineal 0.36-0.46 (6.1-12.9)    compleja 5.3-12.3 (0.41-2.43)
    pajaro f = 3, las 32 regiones ≥ 320 px      0.79-0.99  igual a la unión o mejor       fondo compleja 6.36 (0.37)
    ```
    Ajustar siempre sobre la unión volvía complejas las 10 regiones del bicúbico (bordes suaves de 4-6 px) con radio 1, 7 con radio 2, y
    añadía una compleja en pajaro; con radio 2 radialDisc quedaba en r 45.57 (5.07 %). Con la regla: radialDisc r 46.72 (2.7 %), centro
    (60.00, 66.00), 4 paradas, 2 capas, fidelidad 0.9984; gradientFeathers, el bicúbico y pajaro no cambian.
  · `tests/pipeline/gradientRoundTrip.test.ts` (potrace), umbrales del plan con lo medido: gradientFeathers(256) sin avisos, U 4, cutout, 11
    capas (10 ± 1), 8 <linearGradient> y 0 radiales, una capa distinta pinta ≥ 90 % del núcleo de cada forma (sin evenodd en las plumas),
    RMSE de núcleo por forma 1.36 / 1.27 / 1.07 / 1.10 / 1.30 / 1.01 / 1.08 / 1.52 / 0.00 (< 2), costuras 0 / 5473 (< 0.1 %), fidelidad
    0.9982 (≥ 0.98), 571 nodos, 20 574 bytes; radialDisc 1 <radialGradient>, centro a 0.00 px (≤ 2), r 2.7 % (≤ 5 %), fidelidad 0.9984
    (≥ 0.98, la cifra de la verificación en navegador del plan); ±3: 13 capas, 8 lineales, 0.9977 (≥ 0.97); flatShapes3: 3 capas sólidas a
    ≤ 2 niveles de la paleta, sin <defs>, acuerdo 100.00 % (9107 / 9107, ≥ 98 %), fidelidad 0.9966; noisePhoto(64): 'gradient-fallback' con
    su motivo y 16 capas; convención U = 1, 2, 4: coordenadas / U idénticas a ≤ 0.1 px (difieren solo en el redondeo a 3 decimales), peor eje
    0.45-0.46° (≤ 3°), peor RMSE de núcleo 1.52-1.54 (< 2); gradientFeathers ×8 bicúbico (2048², f = 2): 10 capas, 8 lineales con eje ≤ 3°;
    celdas de 20 px: fallback por regiones. gradientMode.test.ts pasa de esperar el fallback en flatShapes3 a esperar 3 capas sin aviso; el
    fallback se prueba con noisePhoto(64).
  · Tuner: `prepare()` memoiza fitGradientRegions por imagen (WeakMap en el contexto) con clave background|regionDetail|maxStops|
    radialGradients. autotune(gradientFeathers(128), { mode: 'gradient' }): 0.9669 → 0.9770 (fidelidad 0.9877 → 0.9850, dentro de la
    guarda), 71 evaluados, completo, 1.3 s, svg === trace(result.params).svg. Antes del arreglo de regionMask: 0.8861 → 0.9083.
  · pajaro (4001×4001, potrace, U 1) en gradient forzado frente a la fila actual del bench (Auto → flat, 19 colores exactos), misma medida
    (renderAt1x sobre borderColor):
    ```
    modo      ms    capas  lineales  paths  nodos   esquinas  bytes      fidelidad  SSIM    IoU     MAE   pct16   maxRSS durante trace()
    flat      2229  19     0         9767   46022   0.048     1 891 025  0.9810     0.9957  0.9590  0.79  0.0410  +444 MB
    gradient  3336  33     19        46     836     0.089     37 492     0.9956     0.9957  0.9953  0.38  0.0047  +149 MB
    ```
    f 3 (1334²), σ̂ 0.019, edgeShare 0.0371, 56 regiones crudas → 33 en 1 ronda: 14 sólidas (7 azules marino #013780), 18 lineales, 1
    compleja pintada con su mejor candidato (lineal de 4 paradas, rmse 8.81 frente a plano 14.33, 196 704 px = 9.1 % de la tinta; candidata a
    splitComplex); ningún radial ni ninguna región con banda profunda. RMSE de la tinta ponderado por área 2.71 frente a 21.90 del plano;
    90.9 % de la tinta en regiones no complejas, todas con rmse ≤ 2.5. Tiempos: fitGradientRegions 871-1245 ms, preparar (resample,
    refineLabels, orden) 606 ms, trazar 33 máscaras 1918 ms. Memoria (process.memoryUsage): arrayBuffers 291 MB antes (fuente y decodificado),
    187 tras el ajuste (libera el decodificado), 293 tras preparar y durante el trazado (el ajuste retiene la copia compuesta de 64 MB y los
    rangos Uint16 ocupan 32 MB; una máscara viva de 16 MB); maxRSS +149 MB (flat +444 MB: 19 máscaras ansiosas de 16 MB).
  · Todas las muestras con el modo forzado (información para la fase 7; fidelidad frente a la fuente efectiva sobre borderColor):
    ```
    muestra     f  σ̂      edgeShare  regiones (crudas → finales)       capas  lin  rad  nodos   bytes     fidelidad  bench (modo)
    GENTERA     1  0.000  0.012      6 → 6 sólidas                     6      0    0    1215    46 346    1.000      0.999 (flat)
    Instagram   2  0.147  0.045      8 → 6 (2 complejas, 70.7 %)       6      3    0    336     14 475    0.868      0.940 (photo)
    clip_art    fallback: el 76 % de la imagen es borde               2      0    0    808     26 781    0.957      0.960 (flat)
    eagle       fallback: el 63 % de la imagen es borde               14     0    0    12172   423 369   0.900      0.900 (photo)
    avatar      1  0.043  0.075      39 → 34 sólidas                   34     0    0    1262    41 830    0.996      0.995 (flat)
    pajaro      3  0.019  0.037      56 → 33 (1 compleja, 1.2 %)       33     19   0    836     37 492    0.996      0.981 (flat)
    splash      1  0.573  0.570      799 → 551 (16 complejas, 64 %)    390    34   3    7755    279 015   0.888      0.897 (photo)
    ```
    Instagram y splash empeoran en gradient (regiones complejas grandes: rampas multicolor que ni lineal ni radial explican): el clasificador
    de la fase 7 no debe elegir gradient con explained bajo.
  · Bench (potrace), tras la fase 6 (idéntico a la fase 0 salvo ms):

    ```
    image                            dims  mode   U      ms  layers  paths   nodes  corner  naive     bytes  fidel   ssim    iou    mae  pct16  warnings
    GENTERA                     1561x1672  flat   2    1029       6      9    1853   0.012  0.095     70527  0.999  1.000  0.999    0.0  0.001  -
    Instagram                   3840x2160  flat   1     930      12   4477   60446   0.020  0.020   2391810  0.940  0.991  0.862    1.6  0.138  photo
    clip_art                      290x193  flat   4      97       2     55     678   0.080  0.085     22664  0.960  0.993  0.910    1.2  0.090  baked-checkerboard
    eagle                         350x350  flat   4     356      14    316   22702   0.042  0.057    772116  0.900  0.983  0.776    2.9  0.224  photo
    Compartamos avatar            800x800  flat   2     284       3     44    1027   0.167  0.302     33362  0.995  0.999  0.988    0.2  0.012  -
    pajaro                      4001x4001  flat   1    2175      19   9767   46022   0.048  0.050   1891025  0.981  0.996  0.959    0.8  0.041  large-input
    splash                        740x740  flat   2     397      16   2675   36945   0.058  0.068   1268085  0.897  0.950  0.818    2.6  0.182  baked-checkerboard,photo
    ```

- Degradados, fase 7: clasificador, `GradientProbe` y bench con el pájaro (`src/core/classify.ts`, `tests/core/classify.test.ts`,
  `tests/bench/gradientProbe.test.ts` nuevo, `tests/bench/realImages.test.ts`), 2026-09-11. Fuera de la clasificación nada cambia: GENTERA,
  Instagram, clip_art, eagle, avatar y splash dan en el bench las mismas filas que en la fase 6 (salvo ms); solo pajaro cambia de modo.
  · Tabla de medida (`BENCH=1 npx vitest run tests/bench/gradientProbe.test.ts`, potrace). sondeo = analyzeSource lo calcula; los valores son
    los de probeGradients sobre la fuente efectiva aunque analyzeSource no lo calcule; pxMs = mediana de 5 sobre el proxy ≤ 512 px, fullMs =
    con la composición y la reducción de la imagen completa; modo = el clasificado (* = aviso photo); fidAuto / fidGrad = fidelidad del trazado
    clasificado y del forzado a gradient (la medida del bench):
    ```
    image                      dims   f   pal  offSh  sondeo  sigma   edge    reg   expl    lin    rad    pxMs  fullMs  modo      fidAuto  fidGrad  trazado gradient
    GENTERA               1561x1672   4     6  0.001  no      0.000  0.049      6  1.000  0.000  0.000    17.6      64  flat       0.9993   0.9996  6 capas, 0 lin
    Instagram             3840x2160   8  null  0.100  sí      0.118  0.161      6  0.294  0.757  0.000    43.5     114  flat*      0.9395   0.8684  6 capas, 3 lin
    clip_art                290x193   1     2  0.041  no      1.052  0.756    179  0.000  0.000  0.000     5.0       7  flat       0.9597   0.9566  fallback, 2 capas
    eagle                   350x350   1  null  0.260  sí      0.465  0.633    287  0.000  0.000  0.000    14.3      14  flat*      0.9000   0.8999  fallback, 14 capas
    Compartamos avatar      800x800   2     3  0.010  no      0.013  0.145     25  1.000  0.000  0.000    36.4      51  flat       0.9946   0.9958  34 capas, 0 lin
    pajaro                4001x4001   8    19  0.015  sí      0.018  0.090     39  0.988  0.096  0.000    49.5     180  gradient   0.9956   0.9956  33 capas, 19 lin
    splash                  740x740   2  null  0.161  sí      1.166  0.768    466  0.000  0.000  0.000    13.0      19  flat*      0.8973   0.8881  390 capas, 34 lin, 3 rad
    gradientFeathers        256x256   1  null  0.095  sí      0.011  0.119     11  1.000  0.110  0.000    12.3      13  gradient        -        -
    radialDisc              128x128   1     9  0.031  sí      0.092  0.368      2  1.000  0.000  0.443     2.7       3  gradient        -        -
    diagonalSweep           128x128   1     9  0.017  sí      0.162  0.091      2  1.000  0.542  0.000     9.1       9  gradient        -        -
    gradientFeathers ±3     256x256   1    19  0.029  sí      0.796  0.118     13  1.000  0.108  0.000    27.5      28  gradient        -        -
    noisePhoto               64x64    1  null  0.782  sí      0.198  0.943     23  0.000  0.000  0.000     0.6       1  flat*           -        -
    noisePhoto(256)         256x256   1     7  0.823  sí      0.200  0.931    370  0.000  0.000  0.000    12.3      12  flat*           -        -
    flatShapes3              96x96    1     3  0.008  no      0.000  0.121      3  1.000  0.000  0.000     1.0       1  flat            -        -
    ```
  · Rama del sondeo (desviación del contrato, medida): el plan suponía el pájaro en la rama foto, pero `samples/pajaro.png` tiene 19 colores
    exactos con offPaletteShare 0.015 (flat desde la fase 0), radialDisc y diagonalSweep 9 (0.031 / 0.017) y gradientFeathers ±3 19 (0.029).
    Con el sondeo solo en la rama foto ninguno llega a él y "pajaro, radialDisc y diagonalSweep → gradient" es inalcanzable con cualquier
    constante. La paleta exacta de una rampa suave es una escalera de colores dentro de la tolerancia, así que también se sondea con
    paletteColors ≥ `GRADIENT_PROBE_MIN_COLORS` 8. Paletas medidas (analyzeSource): arte plano ≤ 6 (GENTERA 6, avatar 3, flatShapes3 3 con y
    sin ±3, clip_art 2, ringedDisc 2-3, accentIcon 3; aaCircle, glyph, transparentLogo y bakedCheckerLogo 1-2 y además lines); degradados ≥ 9
    (radialDisc 9 limpio, 10 con ±3, también a 256 px; diagonalSweep 9-10; gradientFeathers(128) 15; gradientFeathers ±3 semillas 1 y 3: 19 y 21;
    pajaro 19). 8 es el entero central entre 6 y 9: GENTERA, clip_art, avatar y flatShapes3 siguen sin sondeo. Límite conocido: hueRamp (rampa
    roja → verde a lo ancho, 6 colores exactos) queda fuera y sigue flat.
  · En la rama flat la paleta exacta ya cubre la imagen, así que gradient exige además degradados: linearShare + radialShare ≥
    `GRADIENT_FLAT_MIN_GRADIENT_SHARE` 0.05. Sondeo de arte plano: 0.000 en todos (GENTERA, avatar, flatShapes3 con y sin ±3, ringedDisc,
    accentIcon, glyph, aaCircle, transparentLogo, bakedCheckerLogo); objetivos: pajaro 0.096 (el fondo blanco es el 86.5 % del área
    etiquetada), gradientFeathers ±3 0.108, radialDisc 0.443, diagonalSweep 0.542. 0.05 es la mitad del menor. En la rama foto no se exige: allí
    falló la paleta exacta y regiones planas bien explicadas ya bastan.
  · `GRADIENT_MAX_EDGE_SHARE` 0.6, el límite de fallback del pipeline (un test fija que son iguales; no se importa porque pipeline importa
    classify): objetivos ≤ 0.368 (radialDisc); eagle 0.633, donde el modo Degradados cae a la paleta plana (fidGrad 0.8999 < 0.9000). Como el
    pipeline, el sondeo no ajusta nada por encima (explained 0): eagle 65 → 14 ms, splash 127 → 13, noisePhoto(256) 98 → 12, y el aviso photo
    no sugiere Degradados donde caería al fallback (ajustando, eagle daba explained 0.989).
  · `GRADIENT_MIN_EXPLAINED` 0.85, el provisional: objetivos ≥ 0.988 (pajaro); el mayor por debajo con bordes ≤ 0.6 es Instagram 0.294, que en
    gradient empeora (0.8684 < 0.9395) y debe seguir photo. Todo valor en (0.294, 0.988] separa la tabla; 0.85 deja 0.138 de margen al pájaro.
  · `GRADIENT_MAX_REGIONS` 400, el provisional: no decide ninguna fila (la mayor cuenta ajustada es 39, pajaro; las de 179-466 de clip_art,
    eagle, splash y noisePhoto(256) caen antes por bordes), así que se conserva el valor del plan. `GRADIENT_SUGGEST_EXPLAINED` 0.5, el del
    plan: con el límite de bordes ninguna muestra del bench lo alcanza en la rama foto (Instagram 0.294, eagle, splash y noisePhoto 0).
  · Tiempo (objetivo del plan: ≤ 60 ms en el proxy). Con maxStops 8 Instagram tardaba 111-122 ms en su proxy de 480×270: dos regiones
    complejas multicolor (21 119 y 10 459 píxeles de núcleo) cuestan 45 + 41 ms de fitLinear, sin depender del número de píxeles (ajustando sobre
    una retícula de paso 2, 3 o 4: 36-51 ms), así que submuestrear no sirve (probado y retirado). Barrido maxStops × lado del proxy en las 14
    filas: con 8, 6 y 4 paradas TODOS los valores del sondeo son idénticos y el tiempo baja (Instagram 111 / 69 / 45 ms, gradientFeathers ±3
    53.5 / 50.5 / 27.5, pajaro 54.1 / 53.6 / 48.7); un lado de 384 o 256 px cambia los valores (pajaro explained 0.985 / 0.952, Instagram 7 /
    21 regiones) y no acelera Instagram (384 px con 8 paradas: 201 ms). Elegidos `GRADIENT_PROBE_MAX_STOPS` 4 y `GRADIENT_PROBE_MAX_SIDE` 512:
    máximo 49.5 ms (pajaro), Instagram 43.5, gradientFeathers ±3 27.5. Con la imagen completa (componer y reducir 16 Mpx) pajaro 180 ms e
    Instagram 114.
  · `explained` sigue la definición del encargo (rmse ≤ max(2.5, 2σ)); el comentario de `GradientProbe.explained` en types.ts dice "no complex"
    y el de `SourceInfo.gradientProbe` "solo en la rama foto": difieren en regiones complex con rmse ≤ esa cota (cuentan) y sólidas de núcleo
    < 64 px con rmse mayor (no cuentan), y en la rama del sondeo (arriba). Pendiente de actualizar por quien lleve types.ts.
  · pajaro, conteo sobre la fuente (recortes a resolución completa): 12 plumas (5 del ala izquierda, 3 del ala derecha, 1 del vientre, 3 de la
    cola) y 6 formas más con degradado (cuello y cuerpo, franja del cuello, cabeza, brillo de la cabeza, banda púrpura, vientre oscuro) = 18
    formas con degradado; con 12 sombras azul marino y el fondo, 31 formas. SVG en Auto: 33 capas = fondo + 12 azul marino (#013780) + 19
    `<linearGradient>` (las 18 formas; el cuello corta la pluma verde amarillenta en dos piezas) + una mota verde sólida de 13 px; 0 radiales.
    Bench: 19 `<linearGradient>` ≥ ceil(0.9 · 18) = 17; 33 capas ≤ 1.5 · 31 = 46.5. Motivos: "El 99 % de los píxeles se explica con 39 regiones
    de color plano o degradado (el 10 % con degradados): se vectoriza en modo Degradados." y "Sus 19 colores planos cubren la imagen, pero
    partirían cada degradado en bandas de color."
  · pajaro, fidelidad: "≥ MEASURED anterior + 0.02" es inalcanzable (0.981 + 0.02 = 1.001 > 1). Medido 0.9956 (+0.0146): el bench exige la
    ganancia más estrecha alcanzada, +0.014, además de ≥ 0.97 y del suelo MEASURED, que pasa a 0.996 / 0.995 (IoU 0.959 → 0.995). eagle,
    Instagram y splash siguen en photo con sus filas MEASURED intactas (en gradient 0.8999 / 0.8684 / 0.8881 frente a 0.9000 / 0.9395 / 0.8973);
    el bench fija además su modo flat.
  · Bench (potrace), fase 7 (la columna modo se ensanchó a 8):
    ```
    image                            dims  mode      U      ms  layers  paths   nodes  corner  naive     bytes  fidel   ssim    iou    mae  pct16  warnings
    GENTERA                     1561x1672  flat      2    1036       6      9    1853   0.012  0.095     70527  0.999  1.000  0.999    0.0  0.001  -
    Instagram                   3840x2160  flat      1     910      12   4477   60446   0.020  0.020   2391810  0.940  0.991  0.862    1.6  0.138  photo
    clip_art                      290x193  flat      4      96       2     55     678   0.080  0.085     22664  0.960  0.993  0.910    1.2  0.090  baked-checkerboard
    eagle                         350x350  flat      4     358      14    316   22702   0.042  0.057    772116  0.900  0.983  0.776    2.9  0.224  photo
    Compartamos avatar            800x800  flat      2     288       3     44    1027   0.167  0.302     33362  0.995  0.999  0.988    0.2  0.012  -
    pajaro                      4001x4001  gradient  1    3308      33     46     836   0.089  0.092     37492  0.996  0.996  0.995    0.4  0.005  large-input
    splash                        740x740  flat      2     443      16   2675   36945   0.058  0.068   1268085  0.897  0.950  0.818    2.6  0.182  baked-checkerboard,photo
    ```

- Degradados, revisión de hallazgos (`src/core/edges.ts`, `regions.ts`, `fillModel.ts`, `fillEval.ts`, `pipeline.ts`, `classify.ts`,
  `src/svg/assemble.ts`, `src/ui/warnings.ts`, README, tests; `tests/fixtures/gradientCases.ts` nuevo), 2026-09-11. Flat, lines y pixel sin
  cambios: en el bench GENTERA, Instagram, clip_art, eagle, avatar y splash dan las mismas filas que en la fase 7 (salvo ms). Cada hallazgo
  tiene su test, que fallaba antes del arreglo con las cifras "antes".
  · Rampas empinadas (edges.ts, alta): la histéresis del Sobel inundaba una rampa de pendiente s ≥ sobLo/2 = 4.8 niveles/px (Sobel 2s) desde su
    contorno AA. `gateSobel` (contrato en edges.ts): un píxel débil sigue en la histéresis solo cerca de actividad del laplaciano
    (`SOBEL_GATE_RADIUS` 1) o si destaca de su entorno (Sobel − mínimo a `SOBEL_CONTRAST_RADIUS` 2 px > sobLo); si no, 0. El capado a sobLo en
    Float32 quedaba por encima del umbral double (9.6000004 > 9.6): se usa 0. Variantes medidas (edgeShare / regiones / complejas por área /
    núcleo del interior de steepRamp(24)), laplaciano a radio L y contraste a radio C (−1 = sin esa prueba):
    ```
    variante        gradientFeathers  bicúbico ×8 (f 2)            radialDisc  noisePhoto(64)        steepRamp(24)
    sin puerta      0.119 / 23        10 reg, 8 lineales            0.368       0.931 / 23            0 / 1892
    L1, C−1         0.119 / 23        plumas 3 y 4 fundidas (6.5)   0.113       0.411 / 19, 0.91      1476 / 1892
    L2, C−1         0.119 / 23        fundidas                      0.134       0.636 / 27, 0.73      1280 / 1892
    L−1, C3         0.119 / 23        12 reg, 8 lineales            0.090       0.292 / 7, 0.97       1680 / 1892
    L1, C2 (elegida) 0.119 / 23       12 reg, 8 lineales            0.113       0.438 / 19, 0.91      1476 / 1892
    ```
    El laplaciano solo no ve el contacto suave 3/4 del bicúbico (sus lóbulos quedan a 2-3 px); el contraste lo separa. steepRamp(w) forzado
    a gradient: w 24 RMSE interior 202.9 → 0.29 (fidelidad 0.2784 → 0.9775; flat 0.9606), w 36 203.1 → 0.40 (0.2674 → 0.9813; flat 0.9525),
    núcleo del interior 0.780 / 0.841 / 0.892 para w 24 / 36 / 48 (test ≥ 0.75 / 0.8 / 0.85). radialDisc(128): edgeShare 0.368 → 0.113, el
    núcleo ya abarca el anillo y la regla de banda profunda de la fase 6 no se activa.
  · Trazos finos (regions.ts, alta): una barra de ≤ 5 px no tenía núcleo y el crecimiento por color la daba al fondo. Huérfanos: el crecimiento
    guarda de qué píxel core partió cada píxel; los que difieren de él más de `ORPHAN_STEP_RATIO`·sobHi (48) y no son mezcla de los primeros
    píxeles core que alcanzan sus 8 rayos (`ORPHAN_RAY_LENGTH` 8) salen de la región en grupos de ≥ `ORPHAN_MIN_AREA` 16 px; con núcleo fino
    (píxeles que no son mezcla de sus vecinos en x ni en y a `THIN_BLEND_RATIO`·sobHi = 12; si no queda ninguno, todos). Sin el mínimo de 16
    px, los píxeles AA donde se juntan tres colores (no son mezcla de dos) formaban regiones de 1-3 px cuyos colores, fundidos en el fondo,
    volvían complejo el fondo del sondeo (explained 1 → 0.058 en feathersWithBars). thinBars: núcleo por barra 0 → 100 / 200 / 300 / 400 en
    las de 2-5 px, media de R en sus columnas cubiertas 255 → 20.2-20.9 (tinta 20), fidelidad 0.7709 → 0.9885 (= flat); los puntos de 3×3
    px siguen absorbidos (9 < 16) y los de 5×5 son regiones. Límite: un trazo cuyo color es mezcla de lo que lo rodea (gris entre blanco y
    negro) sigue absorbido. Toda región tiene ahora algún píxel core (también las sobrantes aisladas por transparencia).
  · Semitransparentes (regions.ts, alta): `CORE_MIN_ALPHA` 250 → 128 y el canal alfa entra en `rgbEdgeMaps` con transparencia (el borde AA de
    una forma sobre transparencia es borde; su interior de alfa plano, núcleo). semiTransparentDisc (#ff8800, alfa 200): capa #000000 → #ff8800,
    centro 0,0,0,255 → 255,136,0,255 (= flat). transparentLogo(64) en gradient: 1 capa, IoU del alfa 0.9929 (igual).
  · Sondeo (classify.ts, alta): `explained` descuenta los píxeles ajenos de cada región aceptada (a ≥ `GRADIENT_PROBE_INTERIOR_RADIUS` 2 px de
    otra etiqueta y a más de `GRADIENT_PROBE_FOREIGN_RATIO`·sobHi = 48 niveles de su modelo) y vale 0 si las complex superan
    `GRADIENT_MAX_COMPLEX_SHARE` 0.5 (el límite del pipeline, test de igualdad). 1089 px de puntos 3×3 absorbidos en 128²: explained 1 →
    0.93353 (= 1 − 1089/16384). Los casos Auto del hallazgo: feathersWithBars gradient, RMSE de las barras 215.5 → 3.15, fidelidad 0.9116 →
    0.9969 (flat 0.9415); feathersWithRampButton gradient, RMSE del botón 170.9 → 0.49, fidelidad 0.9774 → 0.9989 (flat 0.9445);
    gradientRectsWithSemiDisc gradient, centro del disco 0,0,0,255 → 255,136,0,255.
  · Bajo contraste (edges.ts, media): un escalón localizado (contraste > sobLo, Sobel 0.775·Δ tras el predesenfoque) siembra la histéresis
    (+Infinity) si no hay un píxel fuerte a ≤ `SOBEL_SEED_CLEARANCE` 3 px. Sin esa distancia las semillas cortaban 3 puntas de pluma de
    gradientFeathers(256) (13 capas). lowContrastShapes / lowContrastDisc forzados a gradient (capas; RMSE de las formas interiores; fidelidad;
    flat entre paréntesis):
    ```
    Δ    cuadrado con rombo y cuadrado                          disco concéntrico
    12   2 capas (#3262c2 plano); 10.00; 0.9819 (0.9862)        2 capas, radial falso; 0.47; 0.9946 (0.9878)
    20   4 capas planas; 0.17; 0.9951 (0.9916)                  3 capas planas; 0.04; 0.9951 (0.9916)
    28   4 capas planas; 0.25; 0.9951 (0.9901)                  3 capas planas; 0.07; 0.9951 (0.9901)
    40   4 capas planas; 0.36; 0.9950 (0.9846)                  3 capas planas; 0.08; 0.9951 (0.9847)
    ```
    Antes, Δ 20 y 28: 2 regiones (una capa con la media, RMSE 17 / 24, o un radial falso). Límite: Δ 12 da Sobel 9.3 < sobLo 9.6 y sigue sin
    separarse; bajar sobLo es bajar el umbral del plan.
  · Fusiones (fillModel.ts, media): con una muestra por paso (> `MERGE_MAX_JOINT_PIXELS`) fitRadial no encontraba soportes 9×9 y el ajuste
    conjunto nunca era radial; ahora lee los soportes de seg.core y las regiones del par. Las dos mitades de radialDisc(512) (radial rmse 0.43
    y 0.42): planMerges [] → [[2, 1]]; splitRadialDisc() en el pipeline: 1 <radialGradient> (la columna elevada, una línea real de 1 px, queda
    en sus capas finas; 5 capas, fidelidad 0.9965). Un grupo con < 64 px de núcleo (sólido por la escalera) que falla el salto se funde si el
    modelo conjunto explica su núcleo con RMSE ≤ max(rmse) + 1.5: la punta de la pluma 5 (72 px, núcleo 3, RMSE conjunto 1.90 ≤ 0.82 + 1.5).
    Como alternativa y no como sustituto del salto: sustituirlo dejaba sin fundir 3 puntas cuyo salto sí pasaba (RMSE 1.80-2.00 > 1.80).
    Coste: ese ajuste conjunto (hasta 32 768 píxeles, repetido tras cada fusión del vecino) llevó el sondeo del avatar de 36 a 2236 ms y el de
    noisePhoto(256) a 41 s. Antes del ajuste, `MERGE_SMALL_MAX_OFFSET` 24 (el suelo Sobel): el RMSE del modelo del vecino extrapolado sobre el
    núcleo del grupo pequeño; medido 0.31 en la punta de la pluma 5 frente a 114-168 en los otros 17 candidatos de gradientFeathers(256) y
    177-179 en los 117 del avatar. Exigir ahí max(rmse) + 1.5 dejaba 4 fragmentos de pajaro sin fundir (37 capas); un ajuste solo con los
    píxeles vecinos (margen de 16 px) rechazaba la punta de la pluma 5 (11 capas) y seguía costando 719 ms en el avatar. Con el umbral de 24:
    avatar 54 ms, pajaro 33 capas. Además el sondeo y el pipeline comprueban la fracción de complejas tras el primer ajuste y no ejecutan
    planMerges por encima de 0.5 (las complejas no se vuelven explicadas al fundirse): noisePhoto(256) 41 s → 52 ms. Aun así el sondeo de
    pajaro tardaba 81.5 ms en su proxy de 501² (el plan: ≤ 60; medianas de 5: segmentEdges 15, del que 10 son el predesenfoque, segmentRegions
    9.7, modelos 18, planMerges 17, reajuste de las fusionadas): el sondeo pasa `smallGroups: false` a planMerges (esos fragmentos son sólidos y
    cuentan como explicados igual) y baja a 57.4 ms con los mismos valores salvo regiones 38 → 41.
  · Tabla del sondeo tras la revisión (`BENCH=1 npx vitest run tests/bench/gradientProbe.test.ts`, mismas columnas que en la fase 7; la
    ejecución completa pasa de 538 s a 27 s porque noisePhoto(256) ya no ajusta 15-41 s):
    ```
    image                      dims   f   pal  offSh  sondeo  sigma   edge    reg   expl    lin    rad    pxMs  fullMs  modo      fidAuto  fidGrad  trazado gradient
    GENTERA               1561x1672   4     6  0.001  no      0.000  0.076      6  1.000  0.000  0.000    21.8      76  flat       0.9993   0.9996  6 capas, 0 lin
    Instagram             3840x2160   8  null  0.100  sí      0.118  0.197      6  0.000  0.000  0.000    46.7     120  flat*      0.9395   0.9402  fallback, 12 capas
    clip_art                290x193   1     2  0.041  no      1.052  0.927     58  0.000  0.000  0.000     5.6       9  flat       0.9597   0.9566  fallback, 2 capas
    eagle                   350x350   1  null  0.260  sí      0.465  0.684    372  0.000  0.000  0.000    18.3      18  flat*      0.9000   0.8999  fallback, 14 capas
    Compartamos avatar      800x800   2     3  0.010  no      0.013  0.145     37  0.999  0.000  0.000    34.7      64  flat       0.9946   0.9965  35 capas, 0 lin
    pajaro                4001x4001   8    19  0.015  sí      0.018  0.090     41  0.988  0.096  0.000    57.4     189  gradient   0.9982   0.9982  33 capas, 19 lin
    splash                  740x740   2  null  0.161  sí      1.166  0.770    409  0.000  0.000  0.000    16.1      21  flat*      0.8973   0.8993  fallback, 16 capas
    gradientFeathers        256x256   1  null  0.095  sí      0.011  0.119     11  1.000  0.110  0.000    15.9      16  gradient        -        -
    radialDisc              128x128   1     9  0.031  sí      0.092  0.113      2  1.000  0.000  0.443     6.3       6  gradient        -        -
    diagonalSweep           128x128   1     9  0.017  sí      0.162  0.091      2  1.000  0.542  0.000     9.5      10  gradient        -        -
    gradientFeathers ±3     256x256   1    19  0.029  sí      0.796  0.118     13  1.000  0.108  0.000    29.9      28  gradient        -        -
    noisePhoto               64x64    1  null  0.782  sí      0.198  0.451     20  0.000  0.000  0.000     7.0       8  flat*           -        -
    noisePhoto(256)         256x256   1     7  0.823  sí      0.200  0.395    228  0.000  0.000  0.000    46.4      47  flat*           -        -
    flatShapes3              96x96    1     3  0.008  no      0.000  0.121      3  1.000  0.000  0.000     1.1       1  flat            -        -
    ```
    Frente a la fase 7: Instagram forzado a gradient cae por complejas (fidGrad 0.8684 → 0.9402) y splash también (0.8881 → 0.8993); eagle
    sigue cayendo por bordes (0.684); los modos Auto no cambian. noisePhoto queda bajo el límite de bordes y su explained 0 viene de las
    complejas.
  · Extensión de los degradados (pipeline.ts): con la inundación corregida el núcleo termina 2-3 px antes del contorno y r quedaba corto
    (radialDisc r 44.14 frente a 48, 8.0 %, test ≤ 5 %). `extendGradient` sobre la banda profunda de cada región, solo si baja su RMSE:
    r 46.72 (2.7 %), 3 paradas, fidelidad 0.9984; gradientFeathers(256) 10 capas, fidelidad 0.9986, RMSE de núcleo por forma 0.36-0.58
    (antes 1.01-1.52).
  · Fallback por complejas (pipeline.ts): noisePhoto solo caía por bordes gracias a la inundación (0.93); con la puerta es 44 % borde y
    `GRADIENT_MAX_COMPLEX_SHARE` 0.5 lo devuelve a la paleta plana ("el 92 % de la imagen no se explica con colores planos ni degradados"): sin
    él, gradient daba fidelidad 0.3466 / 0.2867 (64 / 256 px) frente a 0.6517 / 0.6078 en flat. En la fase 6 las complejas eran el 70.7 % de
    Instagram y el 64 % de splash forzados, que ya trazaba peor que flat; pajaro 1.2 %.
  · Fallback por bordes antes de etiquetar (pipeline.ts, baja): `segmentEdges` separa la etapa de bordes. Bloques aleatorios de 4 px en
    2000²: fitGradientRegions cae por bordes (100 %) en 781 ms (segmentEdges 670 ms); segmentRegions sobre esos bordes habría sumado 775 ms.
    noisePhoto(2000) cae ahora por regiones (12 970 crudas > 2000) en 1101 ms, sin ajustar modelos.
  · JPEG (baja, arreglo parcial): gradientFeathers(512) guardado con `sips` en JPEG y vuelto a PNG, forzado a gradient:
    ```
    calidad  σ̂      crudas  capas (antes)  modelos                                          fidelidad  Auto (explained)
    PNG      0.013  11      10             8 lineales, 2 sólidos                            0.9995     gradient (1.000)
    q90      0.093  12      10 (10)        8 lineales, 2 sólidos                            0.9880     gradient (1.000)
    q75      0.115  17      10 (12)        5 lineales, 3 lineales y 1 sólido complejos       0.9873     gradient (0.960)
    q50      0.072  113     33 (65)        21 sólidos, 11 lineales y 1 sólido complejos      0.9792     gradient (0.885)
    ```
    La mejora viene de las fusiones de fragmentos pequeños. El estimador de Immerkær no ve el error JPEG (dentro de cada bloque es de baja
    frecuencia y cerca de los bordes queda excluido); su versión alineada con la rejilla de 8 px da, en σ de las posiciones de frontera /
    interiores, q50 0.161 / 0.114 (×1.41), q75 ×1.22, q90 ×1.15, y ×1.25 en diagonalSweep limpio, ×1.95 en clip_art: no separa el JPEG del
    contenido, así que no se usa para escalar umbrales. Límite conocido: a q50 quedan 3.3 capas por forma y las plumas complejas.
  · Tests (hallazgos de tests): gradientFeathers(256) exige exactamente 10 capas (formas + fondo), una etiqueta principal distinta por capa y
    ≥ 0.97 de los píxeles de cada etiqueta en su capa (antes 11: la pluma 5 en una capa lineal y 73 px de su punta en una sólida); costuras en
    los píxeles de contacto entre formas: 3 / 159 a más de 40 niveles (test ≤ 8), 0 blancos; el control con máscaras erosionadas da 18 / 159
    (2 px a U 4) y 152 / 159 (6 px), y la prueba antigua de núcleo daba 0 / 5473 en los tres casos.
  · pajaro (bench): el marco negro de 1 px del original (fila 0 de img/pajaro.jpg incluida) quedaba en el fondo #fefefe. Con los huérfanos es
    una región del proxy (f 3) de 1 px, ajustada en su gris promediado (degradado #a9a9a9 → #7f7f7f); en el proxy, una región sin ningún
    píxel cuyo 3×3 sea todo suyo pasa a sólido del color medio de los píxeles de up que refineLabels le da, y se vuelve a etiquetar: #040404,
    anillo 16 000 / 16 000 → 0 / 16 000 píxeles a más de 40 niveles (test ≤ 1 %; en 2048² con f 2: 8192 → 0). Un trazo fino con degradado a
    lo largo pierde el degradado en un proxy (límite). El vientre oscuro sigue siendo la única región compleja: RMSE interior (≥ 4 px de otra
    capa) 8.84, p99 26 (sombreado 2-D que ni lineal ni radial explican; splitComplex sigue sin implementar); las otras 32 capas ≤ 1.53. El
    bench fija ≤ 1 capa sobre 2.5 y esa ≤ 8.9, el marco ≤ 1 %, 17 ≤ <linearGradient> ≤ 20, y que un degradado de dos colores (a ≤ 3 niveles)
    tiene 2 paradas. `PAJARO_SHAPES` 31 → 32 (el marco). Fidelidad 0.9956 → 0.9982, IoU 0.995 → 0.996; `PAJARO_MIN_GAIN` 0.014 → 0.017.
  · Paradas planas en los extremos (fillModel.ts, README): 6 de los 19 degradados de pajaro salían con 3-4 paradas repitiendo un color. Se
    quitan las paradas extremas a ≤ `FLAT_END_TOL_FACTOR` 2·ε niveles por canal de su vecina y el extremo del degradado se mueve a la que queda
    (el pad pinta lo mismo). Con 1·ε una rampa radial plana en sus 12 px centrales conservaba 3 paradas (1.67 niveles de diferencia). pajaro:
    todos los degradados de dos colores tienen 2 paradas; el vientre 4 (colores distintos).
  · Paradas duras (fillEval.ts, baja): `normalizeStops` conserva dos paradas en un mismo offset; el test del hallazgo (4 paradas, 64×32 sobre
    256×128) pasa de 3 paradas escritas y diferencia máxima 251 a 4 y ≤ 1 nivel entre el SVG y renderLayersAt1x.
  · Ids (assemble.ts, media): `g<h>-<n>` con h = FNV-1a del documento con ids g0, g1…; SVGO (`cleanupIds` desactivado) los conserva.
  · Aviso photo en Degradados (warnings.ts, baja): `mergeWarnings` lo descarta en modo gradient. README: la fila Auto describe también la rama
    de paleta exacta con ≥ 8 colores.
  · Bench (potrace), tras la revisión (tabla del sondeo de la fase 7 actualizada abajo):
    ```
    image                            dims  mode      U      ms  layers  paths   nodes  corner  naive     bytes  fidel   ssim    iou    mae  pct16  warnings
    GENTERA                     1561x1672  flat      2    1030       6      9    1853   0.012  0.095     70527  0.999  1.000  0.999    0.0  0.001  -
    Instagram                   3840x2160  flat      1    1032      12   4477   60446   0.020  0.020   2391810  0.940  0.991  0.862    1.6  0.138  photo
    clip_art                      290x193  flat      4     206       2     55     678   0.080  0.085     22664  0.960  0.993  0.910    1.2  0.090  baked-checkerboard
    eagle                         350x350  flat      4     433      14    316   22702   0.042  0.057    772116  0.900  0.983  0.776    2.9  0.224  photo
    Compartamos avatar            800x800  flat      2     280       3     44    1027   0.167  0.302     33362  0.995  0.999  0.988    0.2  0.012  -
    pajaro                      4001x4001  gradient  1    4672      33     47     831   0.103  0.107     36887  0.998  0.999  0.996    0.1  0.004  large-input
    splash                        740x740  flat      2     453      16   2675   36945   0.058  0.068   1268085  0.897  0.950  0.818    2.6  0.182  baked-checkerboard,photo
    ```

- Degradados, división de regiones complejas (`src/core/fillModel.ts` splitComplex, `src/core/pipeline.ts` splitComplexRegions y smoothParts,
  `tests/core/fillModel.test.ts`, `tests/pipeline/gradientSplit.test.ts` nuevo, `tests/bench/realImages.test.ts`), 2026-09-11. El vientre oscuro
  de pajaro era la única región grande que ningún degradado de un solo eje explicaba. Medidas de partida (proxy f = 3, 1334², σ̂ 0.019, 58
  regiones crudas y 33 tras una ronda de fusiones): región 25, núcleo 19 967 px (1.2 % del núcleo), caja (586,829)-(899,1026) = 314×198, lineal
  de 4 paradas a 76°, rmse 8.81 frente a 14.33 del plano. Con maxStops 4, 8, 16 y 32 el Douglas-Peucker converge a las MISMAS 4 paradas y al
  mismo 8.81, y el radial va de 10.91 (2 paradas) a 9.05 (6 paradas): el problema no es el número de paradas. `fitPlane` da 4.03, menos de la
  mitad, así que los gradientes de los tres canales no son colineales ahí y ningún degradado SVG de un eje puede expresarlo; la respuesta
  expresable en SVG es partir la región.
  · k-means determinista, k = 2, sobre (x, y, residuo de luma con signo del relleno actual), los tres rasgos escalados a [0, 1] (x e y por la
    caja de la región, el residuo por su rango) para que la geometría y el error de color pesen igual; semillas = los píxeles de residuo máximo
    y mínimo (empate: el índice menor), `SPLIT_KMEANS_ITERATIONS` 12 pasadas y parada en cuanto ningún píxel cambia de grupo. Cada parte se
    ajusta con selectModel, así que puede salir sólida, lineal o radial.
  · Un nivel se acepta solo si las dos partes tienen ≥ `MIN_MODEL_CORE` 64 px de núcleo Y el RMSE ponderado por núcleo baja a
    ≤ `SPLIT_MAX_RMSE_RATIO` 0.8 del de la región (20 % relativo) Y al menos `SPLIT_MIN_RMSE_GAIN` 1.5 niveles en absoluto. Las dos cotas
    juntas, no una u otra: la relativa sola aceptaría 0.5 → 0.3 en una región ya buena (partir el ruido) y la absoluta sola aceptaría 40 → 38.5
    en una que seguirá estando mal. Medido: el vientre 8.81 → 3.85 pasa (56 % y 4.96 niveles); la región 11 de pajaro (sólida, núcleo 1934 px,
    rmse 4.45 igual a su plano, ruido sin estructura) devuelve null en las tres profundidades, que es lo que debe hacer.
  · `SPLIT_MAX_DEPTH` 2, elegida midiendo el vientre (una parte que la escalera sigue llamando complex se vuelve a partir):
    ```
    maxDepth  partes  rmse por parte      ponderado por núcleo
    -         1       8.81                8.81
    1         2       4.51 / 2.93         3.85
    2         3       1.63 / 2.73 / 2.93  2.61
    3         3       iguales que con 2   2.61
    ```
    Con 3 no cambia nada (la parte de 2.93 intenta otro nivel y no gana el margen), así que 2 es la menor profundidad que deja de mejorar.
    Honestamente: dos de las tres partes siguen por encima de T_LIN = max(2.5, 2σ̂) = 2.5 (2.74 y 2.92 tras el reajuste), así que el vientre NO
    queda entero bajo el umbral de la escalera. Lo que sí baja es el error real: 8.81 → 2.61 ponderado, y el peor RMSE interior del SVG 8.84 →
    2.83.
  · Cableado en fitGradientRegions: después de las fusiones y DESPUÉS del fallback por complejas. El orden importa: una imagen que es casi toda
    compleja no es arte plano y partirla no la convierte en eso (splash con el 64 % del área en complejas e Instagram con el 70.7 %, forzados a
    gradient, siguen cayendo al fallback sin ejecutar ni un k-means). Se parten por área descendente (id como desempate) y mientras la cuenta de
    regiones quepa en `MAX_GRADIENT_REGIONS`; la parte 0 conserva el id de la región y las demás reciben ids nuevos al final.
  · La división cubre TODOS los píxeles de la región, núcleo y banda: el k-means solo ve el núcleo de ajuste, y cada píxel de la banda va a la
    parte cuyo relleno lo predice mejor (error RGB al cuadrado), el mismo criterio que usa `refineLabels` a U×, para que las etiquetas del proxy
    y el refinado a U× no se contradigan en la costura; repartiendo por parte más cercana, un píxel de banda podía caer en una parte cuya rampa
    no llega hasta él. Después se reconstruyen `area` y `regionAdjacency` para las etiquetas nuevas; `core`, `edge`, σ̂ y edgeShare no cambian (el
    núcleo es por píxel, así que un píxel de núcleo de la región vieja lo es de la parte que lo tome, y cada parte conserva ≥ 64). Las partes se
    ajustan como las regiones que crea una ronda de fusión (fitRegionModels con los modelos de las demás intactos), así que su modelo sale de su
    conjunto final de píxeles y la regla de banda profunda también se les aplica.
  · `GRADIENT_SPLIT_SMOOTH_PASSES` 4 (smoothParts): el k-means decide por píxel sobre un residuo, y en la banda decide la comparación de
    rellenos, así que las dos fronteras salen dentadas y el trazador paga un nodo por cada onda. Cada pasada mueve un píxel a la parte a la que
    pertenece la mayoría ESTRICTA de sus 8 vecinos dentro de la misma región, leyendo de una copia de la pasada anterior para no depender del
    orden de barrido (empate: se queda donde está). Si a una parte le quedaran menos de 64 píxeles de núcleo, esa región vuelve a sus etiquetas
    sin alisar. Medido en pajaro con el absorbido de islas ya activo, con fidelidad 0.9994 (cutout) y 0.9986 (stacked) y RMSE de tinta 1.084 en
    las cuatro variantes, y en las DOS formas de capas, porque la revisión señaló que la constante se había elegido solo con cifras de cutout:
    ```
    pasadas  cutout nodos/bytes   stacked nodos/bytes
    0        1257 / 52 595        5870 / 215 066
    2        1177 / 49 858        5412 / 196 790
    4        1175 / 50 328        5287 / 193 239
    6        1172 / 50 241        5276 / 193 130
    ```
    En cutout las pasadas dejan de importar a partir de 2 (de 2 a 4 son 2 nodos menos y 470 bytes más); en stacked 4 sigue siendo el codo (de 2 a
    4 ahorra 125 nodos y 3 551 bytes, de 4 a 6 solo 11 nodos). Se mantiene 4 porque el caso que más paga es stacked. La tabla de la primera
    versión (0 → 2553 nodos, 4 → 1458) se midió sin absorbIslands, que ya quita casi todo lo que el alisado quitaba.
  · `GRADIENT_SPLIT_MIN_ISLAND` = `MIN_MODEL_CORE` 64 px del proxy (absorbIslands), hallazgo de la revisión: el alisado por mayoría solo cuenta
    vecinos de la MISMA región original, así que un trozo pegado al contorno de la región no tiene votantes y sobrevive a todas las pasadas, y
    nada hacía limpieza por componentes conexas. Medido: el vientre de pajaro era UNA región de 21 856 px del proxy y sus tres partes salían en
    8 + 1 + 2 trozos (5562, 25, 19, 16, 8, 8, 7, 2 | 5895 | 10307, 7), es decir 9 islas; a f = 3 una isla de 2 px del proxy son ~18 px a 1x, muy
    por encima del turdsize escalado (2 px² a U = 1), así que potrace emitía un subcamino por isla pintado con el degradado de otra parte. Con
    `bakedBackground: 'keep'`, splash daba 1574+18+1 y 3077+186+61+53+47+12. absorbIslands recorre los trozos 4-conexos de cada parte y mueve todo
    el que baje de 64 px a la parte de la mayoría de sus vecinos de 4 dentro de la región (empate: el índice de parte menor), en rondas que solo
    cuentan vecinos de trozos que NO se mueven (así dos islas no pueden intercambiarse de parte) y que se repiten mientras algo se mueva; un trozo
    sin vecino mayor de otra parte se queda donde está, porque la región ya está partida ahí y eso la segmentación misma lo produce (splash tiene
    30 regiones con varios trozos sin que el split intervenga). El umbral: la isla más grande medida es de 25 px y el trozo más pequeño que es una
    parte de verdad es de 169 px (fixture shadingGrid) y 186 px (el segundo trozo de la región 598 de splash), así que 64 cae en mitad de ese
    hueco, y por debajo de `MIN_MODEL_CORE` un trozo no podría sostener un modelo propio de todos modos. Sin coste de fidelidad y con una rebaja
    clara de tamaño, medido en pajaro (fidelidad 0.9994, MAE 0.08 y pct16 0.0011 con los cuatro umbrales):
    ```
    umbral        trozos de las tres partes          nodos  bytes
    sin absorber  5562,25,19,16,8,8,7,2|5895|10307,7  1458  61 799
    16            5569,25,19,16 | 5897 | 10330        1344  57 147
    32            5569 | 5922 | 10365                 1175  50 328
    64 (elegido)  5569 | 5922 | 10365                 1175  50 328
    ```
  · `GRADIENT_SPLIT_MAX_NEW_SHARE` 0.25 (presupuesto de regiones), hallazgo de la revisión: el único techo era MAX_GRADIENT_REGIONS (2 000) y
    `GRADIENT_MAX_COMPLEX_SHARE` se evalúa ANTES de partir, así que una imagen con muchas regiones de sombreado 2-D multiplicaba su cuenta de
    regiones por hasta 2^SPLIT_MAX_DEPTH = 4, y cada región nueva es otra capa, otra máscara, otra llamada a potrace y otro <linearGradient>.
    Fixture shadingGrid (288², 36 sombreados 2-D independientes de 24×24 sobre blanco, el 25 % del lienzo, por debajo del límite de complejas):
    ```
    variante             regiones  split  nodos   bytes   fidelidad  ajuste  trace
    sin partir (HEAD)    37        0        548   22 518  0.9453      82 ms   398 ms
    sin presupuesto      145       36      3838  155 785  0.9902     447 ms  1236 ms
    presupuesto 0.25     46        3        797   30 645  0.9459     369 ms   677 ms
    ```
    El split puede añadir como máximo max(2^SPLIT_MAX_DEPTH − 1, ceil(0.25·regiones)) regiones y se gastan por área descendente, que es donde
    está el error; una región cuyas partes no caben en lo que queda del presupuesto se salta, y una posterior más pequeña todavía puede entrar.
    El suelo 2^SPLIT_MAX_DEPTH − 1 = 3 garantiza que una sola región siempre se puede partir hasta el fondo (crossShading, 5 regiones, lo
    necesita). Con 0.25 el peor caso medido crece un 45 % en nodos y un 36 % en bytes, el mismo orden que el +41 % / +36 % que paga pajaro, en
    lugar de 7×. Lo que se renuncia es explícito: en una imagen de N sombreados igual de importantes solo se arreglan los mayores (3 de 36 aquí:
    fidelidad 0.9453 → 0.9459 en vez de 0.9902). No avisa al usuario: `splitRegions` lo cuenta en GradientFit y un sombreado que no se parte se
    pinta como antes de que splitComplex existiera.
  · Puerta del núcleo verdadero (hallazgo de la revisión): los 64 px de `MIN_MODEL_CORE` que garantizan splitComplex y smoothParts se cuentan
    sobre el núcleo de AJUSTE (núcleo ∪ banda profunda), pero la Segmentation nueva lleva el núcleo VERDADERO y fitRegionModels vuelve a ajustar
    cada parte sobre él: una parte hecha casi solo de banda podía volver con coreCount < 64 (el suelo sólido de la escalera, split desperdiciado)
    o con coreCount 0, donde `fitFlat(n = 0)` devuelve [0, 0, 0] con rmse 0 y complex false, es decir un relleno NEGRO que refineLabels pintaría
    donde el 3×3 del proxy fuese uniforme. Reproducido en un test con una segmentación hecha a mano (núcleo verdadero de 100 px en una esquina,
    núcleo de ajuste completo): sin la puerta la región se parte en 4 y TRES de las cuatro partes salen negras con coreCount 0. Ahora se cuentan
    los píxeles del núcleo verdadero por parte sobre las etiquetas FINALES (después de alisar y absorber) y una región con una parte por debajo de
    64 no se parte. Ninguna muestra cambia (ninguna llegaba al caso), pero la clase de entrada sí llega a splitComplex: en splash las regiones
    complejas 591 (144 px de núcleo de ajuste), 593 (79) y 596 (73) son casi todo banda y solo las frenaba la regla de ganancia.
  · pajaro antes y después (potrace, U 1, f 3, misma medida que el bench):
    ```
    medida                                antes (HEAD)               después
    regiones (crudas → finales)           58 → 33                    58 → 35 (1 región partida en 3)
    rmse de la región del vientre         8.81                       1.64 / 2.74 / 2.92 (2.606 ponderado)
    trozos 4-conexos de esas partes       1 (una sola región)        1 / 1 / 1 (5569 | 5922 | 10365 px)
    peor RMSE interior de capa            8.84                       2.81
    capas por encima de 2.5               1                          2 (2.81 y 2.68; la tercera parte 1.53)
    RMSE de tinta ponderado por núcleo    2.833 (plano 22.37)        1.084 (plano 22.20)
    núcleo de tinta con rmse ≤ 2.5        89.4 %                     91.8 %
    área en regiones complejas            1.39 %                     1.08 %
    capas / <linearGradient>              33 / 19                    35 / 21
    nodos / bytes (cutout, por defecto)   831 / 36 887               1175 / 50 328   (+41 % / +36 %)
    nodos / bytes (stacked)               3869 / 144 366             5287 / 193 239  (+37 % / +34 %)
    fidelidad / SSIM / IoU                0.9982 / 0.9995 / 0.9963   0.9994 / 0.9997 / 0.9989
    fidelidad stacked                     0.9975                     0.9986
    MAE / pct16                           0.12 / 0.0037              0.08 / 0.0011
    fitGradientRegions                    1015 ms                    1273-1475 ms
    trace() (fila del bench)              4672 ms                    4343 ms
    arrayBuffers tras el ajuste / maxRSS  155 MB / 386 MB            179 MB / 388 MB
    ```
    Las cifras de stacked de la columna "antes" son las que midió la revisión sobre HEAD; las demás se midieron aquí. El coste está en el SVG:
    +344 nodos y +13 441 bytes en cutout, que es la forma de capas por defecto de gradient, y +1418 nodos y +48 873 bytes en stacked, donde cada
    máscara es {rank ≥ j} y dos capas más engordan toda la pila (la revisión lo señaló: el coste solo estaba medido para cutout). Dos de las tres
    formas del vientre tienen frontera libre (el corte no sigue ningún contorno del dibujo) y el alisado más el absorbido de islas la ordenan pero
    no la convierten en una curva del trazo. El beneficio es el error local: donde había una mancha plana con 8.8 niveles de error, ninguna capa
    pasa ya de 2.81. Antes de absorber las islas el mismo SVG pesaba 1458 nodos y 61 799 bytes (stacked 7261 y 272 054), con la misma fidelidad.
  · Guardas medidas (corregidas tras la revisión, que encontró esta nota optimista). Ninguna otra muestra del bench cambia una cifra de
    fidelidad o IoU (GENTERA 0.999/0.999, Instagram 0.940/0.862, clip_art 0.960/0.910, eagle 0.900/0.776, avatar 0.995/0.988, splash
    0.897/0.818) y en todas `splitRegions` es 0, pero NO por la misma razón: Instagram, clip_art, eagle y splash caen al fallback (por borde o por
    complejas) y ahí no se ejecuta ningún k-means, mientras que GENTERA y avatar sí se ajustan en gradient; GENTERA sale con 6 regiones y ninguna
    compleja, y avatar con 35 regiones y una compleja de 91 px de núcleo, por debajo de 2·`MIN_MODEL_CORE` = 128, así que splitComplex devuelve
    null antes de cualquier k-means. El fallback por complejas sigue yendo ANTES del split a propósito: splash (64 % del área en complejas) e
    Instagram (70.7 %) forzados a gradient caen igual. Lo que no es cierto es que splash no se parta nunca: con `bakedBackground: 'keep'`, que es
    un parámetro del usuario, no cae al fallback (599 regiones, 26 complejas) y parte 1 región, la que dejaba las islas de arriba; su ajuste tarda
    30 s con y sin split (1065 regiones crudas a f = 1, coste anterior a este trabajo). Tiempos del bench: clip_art 113 ms, eagle 387, Instagram
    1052, GENTERA 1117, avatar 280, splash 517. gradientFeathers(256), radialDisc(128), diagonalSweep(128) y flatShapes3(96) dan `splitRegions` 0,
    fijado en un test, y sus salidas no cambian; aaCircle, sprite32 y transparentLogo tampoco. No hizo falta tocar `GRADIENT_MAX_COMPLEX_SHARE`.
  · Tests. `splitComplex`: una región con dos sombreados que se anulan (la mitad de arriba sube en +x y la de abajo vuelve en −x, medias
    iguales) no tiene eje que ajustar, así que su mejor relleno es un color plano de rmse 39.62, y el split devuelve 4 partes puras (cada una
    entera dentro de una mitad) de rmse 0.28; devuelve null en una rampa limpia (hueRamp), en arte plano (flatShapes3) y con menos de 2·64 px de
    núcleo. Límite registrado en un test, no un objetivo: una costura VERTICAL con mitades que suben en x y en y NO se parte (null), porque las
    dos mitades caen en tramos disjuntos del parámetro de la rampa ajustada y sus paradas siguen a cada una, de modo que lo único sin explicar es
    la variación perpendicular y ningún corte atravesando el eje separa las mitades; el corte siempre cruza el eje ajustado, que es justo lo que
    el vientre necesita. `tests/pipeline/gradientSplit.test.ts`: un cuadrado con R en x, G en y y B contra las dos (una región sin escalones, un
    cuarto del lienzo para quedar por debajo del límite de complejas) se parte y se traza, dos ajustes dan exactamente las mismas etiquetas y
    rellenos, las cuatro fixtures de degradado no se tocan, y con BENCH=1 el vientre de pajaro cumple las cifras de arriba y dos trazados salen
    idénticos byte a byte. Bench: `PAJARO_COMPLEX_RMSE` 8.9 → 2.9 (el peor RMSE interior baja 3.1×) y las capas por encima de 2.5 pasan de 1 a
    `PAJARO_LAYERS_OVER_TARGET` 2 porque el vientre son tres formas; el tope de `<linearGradient>` pasa de ceil(1.1·18) = 20 a
    18 + `PAJARO_BELLY_PARTS` 3 = 21.
  · Tests añadidos al corregir la revisión, en `tests/pipeline/gradientSplit.test.ts` y con `splitComplexRegions` exportada para ellos (ninguna
    muestra llega sola a estos dos casos): shadedInset es un sombreado 2-D dentro de un rectángulo de 112×80 con 6 bloques de 5×5 px de BANDA
    pegados a su borde izquierdo y pintados con el color del punto espejado, de modo que la parte que mejor los predice nunca es la de alrededor y
    el alisado no los alcanza (no tienen votantes); sin absorbIslands quedan cinco trozos de 23 px y con él cada parte es un solo trozo, y el test
    también comprueba que no sobrevive ningún trozo por debajo de `GRADIENT_SPLIT_MIN_ISLAND`. shadingGrid fija el presupuesto (46 regiones, 3
    partidas, ≤ 900 nodos y ≤ 35 000 bytes; sin presupuesto son 36 partidas y 3838 nodos). La puerta del núcleo verdadero se fija con la misma
    imagen en dos variantes: núcleo verdadero completo (se parte y cada región nueva conserva ≥ 64 px de núcleo verdadero y coreCount > 0) y
    núcleo verdadero de 100 px en una esquina (null). Y en BENCH, las tres partes del vientre de pajaro son un solo trozo 4-conexo cada una.

## Worker
`src/workers/protocol.ts` (mensajes), `handler.ts` (lógica pura y testeable en Node), `trace.worker.ts` (envoltorio fino:
único módulo que importa los trazadores wasm —esm-potrace-wasm parchea TextDecoder globalmente— y
`vtracer-web/vtracer.wasm?url`), `client.ts` (hilo principal; contrato con la UI):

```ts
// handler.ts
export function createHandler(deps: { tracers: Record<Engine, Tracer>; now: () => number; yieldToEvents: () => Promise<void> }):
  { handle(req: WorkerRequest, post: (res: WorkerResponse) => void): void; idle(): Promise<void> }
export function isFatalError(e: unknown): boolean
// client.ts
export interface TraceOutput { svg: string; stats: PathStats; resolved: ResolvedParams; warnings: Warning[]; ms: number }
export interface TuneSummary { fidelity: number; cornerFraction: number; nodeCount: number; bytes: number } // protocol.ts; client.ts la reexporta
export interface TuneOutput extends TraceOutput { params: TraceParams; score: number; baseline: TuneSummary; tuned: TuneSummary }
export type CompareTarget = Pick<TraceParams, 'bakedBackground' | 'background'>
export interface CompareOutput { metrics: Metrics; diffMap: ImageData }
export class WorkerClient {
  constructor();
  ready(): Promise<Record<Engine, boolean>>;              // motor en false = no disponible
  setSource(img: ImageData): Promise<SourceInfo>;          // copia img y la envía a todos los workers vivos
  classify(): Promise<ClassifyResult>;
  trace(params: TraceParams): Promise<TraceOutput | null>; // latest-wins: null si lo supera otro trace()
  tune(params: TraceParams, budgetMs: number, onProgress: (p: TuneProgress) => void): Promise<TuneOutput | null>; // 2º worker; null si se cancela o lo supera otro
  cancelTune(): void;
  compare(rendered: ImageData, mode: ConcreteMode, target?: CompareTarget): Promise<CompareOutput | null>; // latest-wins; rendered se copia; target = resolved del trazado medido (sin él, 'auto')
  terminate(): void;
}
```

### src/tuner
```ts
// grid.ts
export function stageAGrid(opttolerance: number): Candidate[]      // 36, anidadas U > blurK > alphamax > turdsize
export function stageBAlphamax(center: number): number[]           // 7 valores: ±0.15 paso 0.05, recortados a [0, 1.334]
export function stageBGrid(seed: Candidate): Candidate[]           // 21 (7 alphamax × opttolerance {0.1, 0.2, 0.4})
export function proxyFactor(width: number, height: number, maxSide?: number): number // ceil(max/256); 1 si ya cabe
export function candidateParams(base: TraceParams, c: Candidate, engine: Engine, size: { width; height }): TraceParams
export function pickSeeds(results: Ranked[], n?: number): Candidate[]   // Ranked.eligible === false va detrás de todas las elegibles; después, puntuación
export function groupByPreprocessing(candidates: Candidate[]): Candidate[]
// autotune.ts
export async function autotune(img: RasterImage, info: SourceInfo, params: TraceParams, tracers: Partial<Record<Engine, Tracer>>,
  opts: { budgetMs; now; yieldToEvents; isCancelled; onProgress }): Promise<TuneResult | null> // null = cancelado
export function metricBackground(info: Pick<SourceInfo, 'borderColor'>): RGB  // color de borde o blanco
export function comparisonBackground(image: RasterImage, info: Pick<SourceInfo, 'borderColor'>, mode: ConcreteMode, background?: BackgroundSetting): RGB
// plano con fondo resuelto opaco → ese color (el SVG lo pinta); si no, metricBackground(info). image = traceInput(img, info, params).image
export const FIDELITY_GUARD = 0.005
export function outranks(a: Standing, b: Standing, fidelityFloor: number): boolean // Standing { score; fidelity; corners; nodes }
// TuneResult añade baseline y tuned (TuneSummary)
export function maskPerimeter(mask: BinaryMask): number
export function renderLayersAt1x(layers: Layer[], U: number, width: number, height: number, background: RGB): RasterImage
// Degradados: renderLayersAt1x escala también layer.gradient por 1/U (scaleGradient); prepare() usa prepareForMode salvo en gradient, donde
// memoiza fitGradientRegions por imagen (la fuente o su proxy, WeakMap del contexto) con clave background|regionDetail|maxStops|radialGradients
// y llama a prepareGradient(img, resolved, info, fit): los candidatos que solo cambian U, desenfoque o potrace no vuelven a segmentar.
// traceLayers, isFullMask y layerMask vienen de core/pipeline; comparisonBackground trata gradient como flat.
```

## Notas de entorno para tests
`tests/setup.ts` fija `process.type = 'renderer'` (para que esm-potrace-wasm no use `require`)
y define un `ImageData` mínimo. vtracer-web se inicializa en tests con
`readFileSync('node_modules/vtracer-web/vtracer.wasm')`.
