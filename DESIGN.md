---
name: image2svg
description: Vectoriza imágenes a SVG sin picos y demuestra la fidelidad del resultado.
status: implemented
colors:
  paper: "#f6f7f9"
  surface: "#ffffff"
  canvas: "#eceff3"
  ink: "#0f172a"
  muted: "#5b6577"
  line: "#dfe4ec"
  line-strong: "#8a95a8"
  accent: "#2451e6"
  accent-deep: "#1a3fbf"
  on-accent: "#ffffff"
  signal-ok: "#127249"
  signal-warn: "#8f5d10"
  signal-bad: "#b42633"
  paper-dark: "#0b0f17"
  surface-dark: "#121826"
  canvas-dark: "#0e131d"
  ink-dark: "#e7eaf0"
  muted-dark: "#8d97a9"
  line-dark: "#222c3d"
  line-strong-dark: "#6b7a96"
  accent-dark: "#7b96ff"
  accent-deep-dark: "#9db0ff"
  on-accent-dark: "#0b0f17"
  signal-ok-dark: "#3ebf85"
  signal-warn-dark: "#d7953d"
  signal-bad-dark: "#ff7173"
  overlay-corner: "#e11d48"
  overlay-curve: "#2563eb"
typography:
  display:
    fontFamily: "'Manrope Variable', 'Manrope', system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 2.2vw, 1.875rem)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  body:
    fontFamily: "'Manrope Variable', 'Manrope', system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 450
    lineHeight: 1.55
  label:
    fontFamily: "'Manrope Variable', 'Manrope', system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    letterSpacing: "0.01em"
  mono:
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 500
    fontVariantNumeric: "tabular-nums"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.line}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
---

# Design System: image2svg

## Overview

**Creative North Star: "Mesa de luz"**

Implementado en `src/styles` (tokens y elementos base en `tokens.css`, controles en `controls.css`,
disposición en `layout.css`). Una herramienta de precisión con aire premium: superficies frías y
silenciosas, tipografía con carácter pero contenida, y el color reservado para lo que significa algo
(una acción principal, un estado de fidelidad, un nodo problemático). La pantalla es una mesa de luz:
la imagen y su vector son los protagonistas; los controles se leen como instrumental, no como
decoración.

Densidad media-alta (VISUAL_DENSITY 4): muchos controles y cifras, agrupados con espacio
generoso entre grupos y compacto dentro de cada uno. Movimiento mínimo (MOTION_INTENSITY 3):
solo feedback (hover, active, foco), transiciones cortas al cambiar de vista y una barra de
progreso real durante el ajuste automático.

**Key Characteristics:**
- Un solo acento, usado en menos del 10 % de la pantalla.
- Cifras y código en mono con numerales tabulares; nunca mono como disfraz.
- El lienzo de comparación decide el fondo: tablero de ajedrez sutil para transparencias, fondo de papel para el resto.

## Colors

Neutros fríos (slate) y un acento cobalto. Colores de señal (ok, aviso, error) solo en el
panel de fidelidad y en avisos; colores de overlay (esquina, curva) solo sobre el lienzo.

### Primary
- **Cobalto** (#2451e6, oscuro #7b96ff): acción principal, slider activo, anillo de foco.
- **Cobalto profundo** (#1a3fbf, oscuro #9db0ff): hover del botón principal; en oscuro aclara en lugar de oscurecer.
- **Sobre acento** (`on-accent`: #ffffff en claro, #0b0f17 en oscuro): texto e icono del botón principal y marca del checkbox.

### Neutral
- **Papel** (#f6f7f9 / #0b0f17): fondo de la página.
- **Superficie** (#ffffff / #121826): paneles y controles.
- **Lienzo** (#eceff3 / #0e131d): tercer tono, fondo del lienzo, del bloque de detección y del segmentado.
- **Tinta** (#0f172a / #e7eaf0): texto principal.
- **Apagado** (#5b6577 / #8d97a9): texto secundario, etiquetas.
- **Línea** (#dfe4ec / #222c3d): bordes de 1 px.

### Signal
- **Ok** (#127249 / #3ebf85), **Aviso** (#8f5d10 / #d7953d), **Error** (#b42633 / #ff7173): estado de
  fidelidad y avisos, siempre acompañados de texto. Cada tema tiene su valor y ese mismo valor sirve para
  texto pequeño, puntos de señal y bordes. Todos conservan el tono OKLCH de la semilla (#178a5b 159.6°,
  #b7791f 70.4°, #c8323f 21.4°) con menos de 1° de diferencia.
- **Esquina** (#e11d48) y **Curva** (#2563eb): puntos del overlay de nodos, iguales en ambos temas.

### Named Rules
**The One Accent Rule.** El acento aparece en menos del 10 % de cualquier pantalla; su rareza es el punto.
**The Contrast Rule.** Todo par de texto y fondo en uso llega a 4.5:1 en los dos temas; la cifra de
fidelidad, el anillo de foco y los objetos gráficos (puntos de señal, bordes de formulario, marca del
checkbox) llegan a 3:1. `tests/ui/contrast.test.ts` lo comprueba leyendo `tokens.css` y exige que las
reglas de `src/styles` sigan usando esos pares.
**Modo.** Ambos juegos se alternan con `prefers-color-scheme` y un toggle manual opcional que
escribe `data-theme`; los tokens viven en `:root` y se redefinen en `[data-theme="dark"]` y en
el media query (los dos bloques oscuros son idénticos, también por test).

## Typography

**Display Font:** Manrope Variable (fallback system-ui)
**Body Font:** Manrope Variable
**Mono:** JetBrains Mono Variable (fallback ui-monospace)

**Character:** Manrope tiene geometría limpia con detalles cálidos; a peso 700 y tracking
negativo suave da titulares con presencia sin gritar. JetBrains Mono, con `font-variant-numeric:
tabular-nums`, hace que las métricas no bailen al actualizarse.

### Hierarchy
- **Display** (700, 1.5 a 1.875 rem, 1.15): nombre de la app y título de sección principal.
- **Headline** (650, 1.0625 rem, 1.3): títulos de panel (Controles, Fidelidad, Salida).
- **Body** (450, 0.9375 rem, 1.55): texto y avisos; máximo 65 a 75 caracteres por línea.
- **Label** (600, 0.8125 rem, +0.01em): etiquetas de controles y cabeceras de métricas.
- **Mono** (500, 0.8125 rem): valores de sliders, métricas, tamaño de archivo, código SVG.

## Layout

Contenedor fluido hasta 1440 px. En escritorio, tres zonas: barra lateral de controles
(320 px), lienzo central que ocupa el resto, y panel de fidelidad y salida (300 px) a la
derecha; por debajo de 1100 px el panel derecho baja bajo el lienzo; por debajo de 760 px todo
apila en una columna con el lienzo primero. Ritmo de espaciado en múltiplos de 4 px; grupos de
controles separados por 24 px, elementos dentro del grupo por 8 px.

## Elevation & Depth

Plano con bordes de 1 px; una sola sombra suave con desplazamiento (0 8px 24px, 8 % de tinta)
reservada al menú flotante y a la barra de progreso del ajuste. La profundidad la dan las capas
tonales: papel, superficie, y un tercer tono para el lienzo.

## Shapes

Un solo sistema de radios: 6 px en inputs y chips, 10 px en botones y paneles, 14 px en el
lienzo. Bordes de 1 px en línea; nunca bordes laterales de color.

## Components

- **Button**: primario en cobalto con texto `on-accent` (blanco en claro, #0b0f17 en oscuro); hover cobalto profundo; foco con anillo de 2 px del acento a 2 px de separación; active `transform: scale(0.97)`; padding 10 px 16 px. Secundario en superficie con borde.
- **Slider**: pista de 4 px en línea, relleno en acento hasta el valor, pulgar de 16 px en superficie con borde de 2 px del acento; el valor se muestra en mono a la derecha de la etiqueta.
- **Segmented control** (Modo, Vista): chips en superficie, el activo en tinta sobre papel invertido, radio 6 px.
- **Input / Select**: borde en línea, foco con anillo del acento, etiqueta encima en Label.
- **Card**: solo los tres paneles principales son tarjetas; nada anidado.
- **Metric**: etiqueta en Label apagado, valor en mono grande, con un punto de señal (ok, aviso, error) y su texto.
- **Iconos**: Phosphor Regular (`@phosphor-icons/core`), 16 px en controles y 20 px en la barra superior.

## Do's and Don'ts

- Do: mostrar cada métrica con número y texto; el color solo refuerza.
- Do: usar tablero de ajedrez sutil bajo imágenes con transparencia.
- Don't: gradientes en texto, eyebrows sobre títulos, tarjetas anidadas, em-dashes, emojis como iconos.
- Don't: animar entradas de cada sección; una sola transición al cambiar de vista.

## Decisiones de implementación (UI)

Tomadas al construir la interfaz; amplían o precisan lo anterior.

- **Dos familias autoalojadas, sin peticiones externas.** Manrope Variable (`@fontsource-variable/manrope`,
  importada en `src/main.ts`) para el texto y JetBrains Mono Variable (`@fontsource-variable/jetbrains-mono`,
  importada al principio de `src/styles/app.css`) como `--font-mono`, siempre con `tabular-nums`. Mono en los
  valores de sliders y de opacidad (`.field__value`), el zoom, la cifra de fidelidad, los valores de las métricas
  (SSIM, IoU, píxeles distintos, nodos, tamaño, tiempo), los recuentos de esquinas y curvas, el archivo y sus
  dimensiones en la barra superior, la línea de salida (archivo, tamaño y nodos) y `code`, `pre` y `samp`. Siguen
  en Manrope, con numerales tabulares, la sublínea de las métricas ("esquinas 12,5 %"), el progreso del ajuste y los
  motivos de detección: son frases con alguna cifra. Los `@font-face` llevan `unicode-range`, así que el navegador
  solo descarga los subconjuntos que usa la página.
- **Escala fija en rem (modo Operate).** Nombre de la app 1.25 rem/750 en la barra superior (sustituye el clamp de
  Display), título del estado vacío 1.5 rem, Headline 1.0625 rem, Body 0.9375 rem, Label 0.8125 rem, pequeño
  0.75 rem y cifra de fidelidad 2.5 rem. Pesos mono: 550 en valores de control y zoom, 600 en métricas y
  recuentos, 700 con tracking -0.02em en la cifra de fidelidad y 500 en archivo y salida.
- **Señal por tema.** `--signal-ok`, `--signal-warn` y `--signal-bad` se redefinen en oscuro y valen a la vez para
  texto, puntos y bordes; desaparecen las variantes `--signal-*-text`. Los valores de la semilla no llegaban a
  4.5:1 como texto y el tema oscuro no los redefinía (el `--signal-ok` #178a5b quedaba en 4.07:1 sobre #121826).
  Los oscuros nuevos están en L 0.72 de OKLCH con el tono exacto de la semilla (los anteriores #3fc48c, #e0a647 y
  #f0707a se desviaban hasta 6.4° en aviso). Contraste sobre superficie / papel / fondo tintado de su aviso:

| Señal | Claro antes | Claro después | Oscuro antes | Oscuro después |
| --- | --- | --- | --- | --- |
| Ok | #178a5b 4.35 / 4.06 | #127249 5.95 / 5.55 | #178a5b 4.07 / 4.40 | #3ebf85 7.60 / 8.22 |
| Aviso | #b7791f 3.64 / 3.40 / 3.39 | #8f5d10 5.61 / 5.24 / 5.22 | #b7791f 4.87 / 5.27 / 4.68 | #d7953d 6.97 / 7.54 / 6.70 |
| Error | #c8323f 5.27 / 4.92 / 4.74 | #b42633 6.43 / 6.00 / 5.78 | #c8323f 3.36 / 3.64 / 3.34 | #ff7173 6.64 / 7.18 / 6.59 |

- **Texto sobre acento.** `--on-accent` por tema: #ffffff en claro (6.19:1 sobre #2451e6 y 8.38:1 sobre #1a3fbf) y
  #0b0f17 en oscuro (6.99:1 sobre #7b96ff y 9.21:1 sobre #9db0ff en hover; el blanco de la semilla daba 2.75:1 y
  2.08:1). La marca del checkbox marcado usa el mismo color.
- **Bordes de formulario.** Select, checkbox y selector de color con `line-strong` #8a95a8 / #6b7a96 (3.02:1 y
  4.09:1 sobre superficie). `line` queda para paneles y separadores; el botón secundario usa `line-control`
  #cdd4de / #2e3a4f y pasa a `line-strong` en hover.
- **Foco.** Anillo de 2 px del acento: 5.77 / 6.19 / 5.36:1 sobre papel, superficie y lienzo en claro; 6.99 / 6.46 /
  6.77:1 en oscuro.
- **Avisos.** Fondo tintado con borde de 1 px, sin bordes laterales de color: aviso #fdf6ea / #ead4ae (oscuro #221b10 /
  #4d3b1c), error #fcf0f1 / #efc4c8 (oscuro #25141a / #55252e).
- **Tercer tono (lienzo).** `canvas` #eceff3 / #0e131d. Tablero de transparencia de cuadros de 8 px: #ffffff y #e6eaf0 en claro,
  #1b2232 y #131926 en oscuro. Las etiquetas y mensajes sobre el lienzo llevan fondo de superficie propio, nunca texto
  directo sobre el tablero.
- **Iconos.** Phosphor Regular reales de `@phosphor-icons/core` (MIT, Copyright (c) 2023 Phosphor Icons). `src/ui/icons.ts`
  importa cada SVG con `?raw` y copia sus `d` en un `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">`:
  Regular ya viene contorneado, sin trazo que escalar. Correspondencia: upload upload-simple, download download-simple,
  copy copy, check check, warning warning, error warning-circle, zoomIn magnifying-glass-plus, zoomOut
  magnifying-glass-minus, fit corners-out, close x, image image, sliders sliders-horizontal. 16 px en controles (también
  el botón pequeño de la barra superior), 18 a 28 px en avisos y estado vacío. `tests/ui/icons.test.ts` compara cada
  `d` con el archivo de Phosphor.
- **Layout.** Columnas 320 px, lienzo y 300 px. Por debajo de 1100 px los resultados bajan bajo el lienzo (controles de
  300 px a la izquierda, resultados en rejilla `auto-fit` de 240 px). Por debajo de 760 px todo apila en una columna:
  lienzo, resultados y controles; en ese mismo corte se apilan los dos paneles de "Lado a lado", se oculta el archivo
  de la barra superior (cabe en una sola línea sin él) y los avisos pasan su acción a otra línea, alineada con el texto: el
  cuerpo del aviso toma `flex-basis: calc(100% - 40px)` y la acción `margin-left: 28px` (icono de 18 px y hueco de 10). Con
  `flex: 1` (base 0) la acción nunca bajaba y en un móvil el texto se quedaba en 71 px de ancho. Sustituye a los cortes
  anteriores de 900 y 600 px.
- **Cifras pendientes de medir.** Entre un cambio de control y la nueva comparación, la cifra de fidelidad y los valores de
  las métricas pasan a `muted` y el punto de señal a `line-strong`, sin opacidad: con `opacity: 0.55` la cifra en aviso
  quedaba en 2.33:1 y los valores en 3.99:1 en claro. Así siguen cumpliendo la Contrast Rule; `tests/ui/contrast.test.ts`
  compone los estados `is-stale` con la opacidad y el color que declaren.
- **Resumen del ajuste.** La línea mono de antes y después usa palabras ("Fidelidad de 86,8 % a 86,6 % · Esquinas de 79 a
  3"): ningún subconjunto autoalojado de JetBrains Mono trae U+2192 y la flecha salía de la mono de reserva.
- **Movimiento.** Transiciones de estado de 150 a 200 ms. Durante el trazado, barra indeterminada de 2 px sobre el lienzo (sin
  spinner) y esqueletos que pulsan; con `prefers-reduced-motion` la barra queda estática y nada pulsa.
- **Acento.** Solo en Descargar SVG, sliders, checkboxes, foco y progreso del ajuste; el segmentado activo usa tinta invertida.
- **Sombra.** Solo en el bloque de progreso del ajuste automático.
