# image2svg

[![Despliegue](https://github.com/Luizun777/image2svg/actions/workflows/deploy.yml/badge.svg)](https://github.com/Luizun777/image2svg/actions/workflows/deploy.yml)
[![Licencia: GPL-2.0](https://img.shields.io/github/license/Luizun777/image2svg)](LICENSE)

Vectoriza imágenes raster (PNG, JPG, WebP, GIF o BMP) a SVG en el navegador y mide la fidelidad del resultado; la imagen
no sale de tu equipo.

**Demo:** [luizun777.github.io/image2svg](https://luizun777.github.io/image2svg/)

Los "picos" (dientes de sierra) aparecen cuando el trazador sigue tal cual la escalera de píxeles del
borde. image2svg la elimina antes de trazar: reescala la imagen hasta 4× con un bicúbico sin sobreimpulso, la suaviza con un
desenfoque gaussiano proporcional al reescalado y la binariza en el nivel del 50 % de cobertura, así Potrace recibe un borde
continuo en lugar de escalones (la receta de `mkbitmap`). Después renderiza el SVG, lo compara con el original (SSIM, IoU,
píxeles distintos) y muestra un mapa de diferencias.

## Modos

| Modo | Para qué | Cómo se traza |
| --- | --- | --- |
| **Auto** | Cualquier imagen | Analiza la paleta, los bordes y la rejilla, elige uno de los tres modos siguientes y explica por qué. |
| **Líneas / logo** | Dibujos a línea, logos de un color, escaneos | Reescalado, desenfoque, umbral de iso-nivel (o la transparencia como máscara) y un único trazado relleno. |
| **Color plano** | Ilustraciones y logos con pocos colores | Paleta exacta (o reducida si hay degradados), una máscara por color y capas apiladas sin costuras. |
| **Píxel exacto** | Pixel art | Detecta la rejilla y emite rectángulos fusionados, sin pérdida y con `crispEdges`. |

- **Motores:** Potrace (principal) y VTracer. Si uno no se puede cargar se usa el otro y se avisa.
- **Ajuste automático:** durante 3 s, en un segundo worker, prueba combinaciones de reescalado, desenfoque, suavizado,
  tolerancia de curva y manchas mínimas (primero sobre una versión reducida si la imagen es grande) y compara con VTracer. Se
  queda con el mejor equilibrio entre fidelidad, esquinas y nodos sin perder más de 0,5 puntos de fidelidad frente a los
  parámetros de partida. Al aplicarlo muestra fidelidad, esquinas, nodos y tamaño antes y después, y qué parámetros cambió.
  Muestra el progreso y se puede cancelar.
- **Avisos:** parece una foto, trazos finos, demasiados rectángulos, reescalado limitado, entrada grande, motor no disponible,
  trazado vacío y transparencia falsa, cada uno con su acción sugerida.
- **Salida:** descargar o copiar el SVG, opcionalmente optimizado con SVGO.

Límites: cada lado de la imagen hasta 4096 px; el reescalado interno no pasa de 16 megapíxeles. Fotos y degradados se
posterizan (y se avisa).

## Transparencia falsa (tablero pintado)

Muchas imágenes que se descargan como "PNG transparente" son opacas: llevan pintado el tablero de ajedrez gris y blanco con
el que los editores indican la transparencia. image2svg lo detecta en el borde de la imagen (también si se reescaló y sus
cuadros ya no miden un número entero de píxeles) y, por defecto, lo trata como fondo transparente: no genera capas grises de
fondo y la fidelidad se mide contra la imagen sin el tablero. Un aviso lo explica.

- **Mantener el tablero**, en el aviso o en **Avanzado > Trazado > Fondo de tablero pintado**, lo traza como parte del diseño
  y lo mide contra los píxeles tal cual. Líneas/logo traza un solo color y no puede reproducir un tablero de dos tonos, así
  que desde ese modo el aviso ofrece **Mantener el tablero en Color plano**. **Tratar como transparente** vuelve al
  comportamiento por defecto.
- La vista **Original** muestra siempre los píxeles reales, con su tablero pintado. La vista **SVG** pone debajo el tablero
  propio de la app (cuadros de 8 px), así se ve qué quedó transparente.

## Uso en local

Requisitos: Node 26 y npm.

```bash
npm install
npm run dev         # http://localhost:5173/image2svg/
npm test            # tests con vitest
npm run typecheck   # app, worker y tests
npm run build       # genera dist/
npm run preview     # sirve dist/ en http://localhost:4173/image2svg/
```

En desarrollo, `?synth=circle`, `line`, `glyph`, `flat`, `sprite` o `logo` carga una imagen sintética sin necesidad de archivo.

### Bench con imágenes reales

Las imágenes de prueba no están en el repositorio (`img/` y `samples/` están en `.gitignore`). Copia los originales a `img/`,
conviértelos a PNG en `samples/` (macOS, usa `sips`) y lanza el bench:

```bash
./scripts/prepare-samples.sh
BENCH=1 npx vitest run tests/bench
```

Sin `BENCH=1` el bench se salta. Cada muestra necesita su suelo medido en la tabla `MEASURED` de
`tests/bench/realImages.test.ts`: una imagen nueva sin esa entrada hace fallar el bench.

Los contratos entre módulos y las decisiones de implementación (con sus mediciones) están en `ARCHITECTURE.md`; el sistema
visual, en `DESIGN.md`.

## Despliegue

### GitHub Pages (producción)

1. Publica el repositorio en GitHub con el nombre `image2svg`. La app se sirve bajo `/image2svg/`; si el repositorio se llama
   de otra forma, cambia `base` en `vite.config.ts`.
2. En **Settings → Pages → Build and deployment**, elige **Source: GitHub Actions**.
3. Cada push a `main` ejecuta `.github/workflows/deploy.yml` (`npm ci`, `npm test`, `npm run build`) y publica `dist/`.
   También se puede lanzar a mano desde la pestaña **Actions** (workflow_dispatch).

La página queda en `https://<usuario>.github.io/image2svg/`.

### Vercel (vista previa opcional)

`vercel.json` fuerza `vite build --base=/`, porque Vercel sirve desde la raíz del dominio en vez de `/image2svg/`. No
afecta al despliegue en GitHub Pages.

```bash
npx vercel deploy --temporary --yes   # vista previa anónima, caduca en 60 min si no se reclama
npx vercel login && npx vercel --prod # despliegue permanente en tu cuenta
```

## Licencias

- **image2svg:** GPL-2.0 (ver `LICENSE`), obligada por `esm-potrace-wasm` (Potrace compilado a WebAssembly, GPL-2.0), que va
  dentro del worker de trazado.
- **vtracer-web:** MIT.
- **SVGO** (optimización opcional, se carga solo cuando se usa): MIT.
- **Manrope** (`@fontsource-variable/manrope`, autoalojada): SIL Open Font License 1.1.
- **JetBrains Mono** (`@fontsource-variable/jetbrains-mono`, autoalojada): SIL Open Font License 1.1.
- **Phosphor Icons** (`@phosphor-icons/core`): MIT.
