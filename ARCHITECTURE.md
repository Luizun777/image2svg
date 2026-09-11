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
  `BakedCheckerboard`, ver bakedBackground). Importar como
  `import type { … } from '../types'`.
- Imágenes: `RasterImage` (RGBA `Uint8ClampedArray`), `GrayImage` (`Float32Array` 0..255),
  `BinaryMask` (`Uint8Array` 0/1, **1 = tinta**), `LabelMap`.
- Coordenadas de paths (`AbsPath`/`Seg`): absolutas, y hacia abajo, origen arriba-izquierda,
  en píxeles del espacio en que se trazó (reescalado). Números en `number`, sin redondeo hasta serializar.
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
```

### src/core/pipeline.ts (integración; se escribe después de los demás)
```ts
export interface PreparedLayer { mask: BinaryMask; fill: string; opacity?: number }
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
// pixel: detectGrid (o gridScale) → downscaleNearest → pixelSvg(…, tamaño de la fuente): el SVG mide siempre lo que la fuente y un gridScale que no la
//        divide conserva los bloques parciales en píxeles fuente; stats: 3 nodos por rect (m h v h z), cornerFraction 1; warning 'too-many-rects' si > 10 000 rects.
//        > MAX_PIXEL_RECTS (200 000): no se construye el SVG (svg '', stats a 0) y 'too-many-rects' explica el límite y remite a Color plano
// trace(): info = analyzeSource(img) solo si hace falta (auto, lines o flat; un modo pixel explícito no la calcula);
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
```

### src/metrics/fidelity.ts
```ts
export interface FidelityInput { original: RasterImage; rendered: RasterImage; mode: ConcreteMode; background: RGB; thresholdNorm?: number }
export function computeMetrics(inp: FidelityInput): Metrics
// ambos compuestos sobre background → gray; ROI = inkBBox(originalGray); SSIM y MAE sobre gaussianBlur σ=0.8; IoU sobre máscaras binarizadas SIN desenfocar (lines: umbral thresholdNorm ?? Otsu del original; flat/pixel: IoU = 1 - pctDiff16); fidelity = 0.6*ssim + 0.4*iou (clamp 0..1)
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
```

## Notas de entorno para tests
`tests/setup.ts` fija `process.type = 'renderer'` (para que esm-potrace-wasm no use `require`)
y define un `ImageData` mínimo. vtracer-web se inicializa en tests con
`readFileSync('node_modules/vtracer-web/vtracer.wasm')`.
