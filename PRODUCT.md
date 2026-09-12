# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite 8 + TypeScript vanilla + CSS propio (sin framework de UI ni librerías de animación). Todo el procesamiento corre en el navegador (Web Workers + WASM). Se despliega como sitio estático en Vercel (image2svg-ashy.vercel.app). Decidido por el usuario.

## Users

Creadores, diseñadores y makers que tienen un logo, un dibujo a línea, una ilustración de color plano o con degradados, o pixel art en baja resolución y necesitan un SVG limpio para escalarlo, cortarlo o editarlo. Llegan con una imagen concreta y una frustración concreta: otros conversores les devuelven trazos con "picos" (dientes de sierra) donde había una línea limpia. Uso puntual, no diario; una sola pantalla.

## Product Purpose

Convertir imágenes raster a SVG de forma fiel: líneas suaves donde el original tenía líneas, colores planos apilados sin costuras, degradados lineales y radiales reconstruidos como degradados SVG editables (una forma, un trazado, un degradado) en lugar de bandas de color, y un modo píxel exacto sin pérdida para pixel art. Éxito: el usuario descarga un SVG que, superpuesto al original, no muestra picos ni huecos, y ve un número de fidelidad que lo confirma.

## Positioning

Mide y demuestra la fidelidad del resultado en vez de solo prometerla: renderiza el SVG de vuelta, lo compara con el original (SSIM, IoU, porcentaje de píxeles distintos), muestra un mapa de diferencias y un overlay de nodos donde los picos se ven como racimos. Elimina los picos por construcción (reescalado con interpolación suave y desenfoque antes de trazar, siguiendo la receta del propio mkbitmap de potrace). Dos motores comparables (potrace y vtracer) y un ajuste automático que se queda con la combinación de mayor fidelidad. Nada sale del navegador.

## Operating Context

Un archivo PNG, JPG, WebP, GIF o BMP arrastrado, pegado desde el portapapeles o elegido con un selector. Resultados en segundos; el ajuste automático puede tardar unos segundos más y muestra progreso. El SVG se descarga o se copia al portapapeles y se abre en Figma, Illustrator, Inkscape o software de corte. Las fotos están fuera de alcance: se avisa y se posterizan. Los degradados de logos e ilustraciones sí se reconstruyen (modo Degradados); si la imagen resulta ser una foto, ese modo vuelve a Color plano y avisa.

## Capabilities and Constraints

- Modos: Auto, Líneas/logo, Color plano, Degradados, Píxel exacto. Motores: Potrace (principal) y VTracer.
- Degradados: segmenta la imagen en formas por sus bordes y ajusta a cada una un color plano, un degradado lineal o uno radial (hasta 8 paradas); cada forma es un trazado recortado con su `<linearGradient>` o `<radialGradient>` en unidades del viewBox, editable en Figma, Illustrator e Inkscape.
- Controles principales: Suavizado (afilado a suave), Umbral, Colores, y en Degradados Detalle de regiones, Paradas máximas y Degradados radiales; botón Ajuste automático con progreso y cancelación. Sección Avanzado plegada: reescalado, desenfoque, tolerancia de curva, manchas mínimas, invertir, fondo, transparencia, capas, rejilla de píxel, parámetros vtracer, optimizar con SVGO.
- Panel de fidelidad: Fidelidad %, SSIM, IoU, píxeles distintos, nodos y porcentaje de esquinas, tamaño del archivo; toggles de mapa de diferencias y nodos; vistas lado a lado, superposición y zoom.
- Avisos previstos: parece una foto (con "Usar degradados" cuando sus formas se explican con degradados), trazos finos que pueden romperse, demasiados rectángulos en modo píxel, reescalado limitado por memoria, entrada demasiado grande (> 4096²), motor no disponible, degradados no reconstruidos.
- Límites: sin servidor, sin cuentas, sin subida de archivos. Entrada máxima 4096×4096 px; reescalado interno hasta 16 megapíxeles.
- Terminología en español: trazo, picos, fidelidad, nodos, esquinas, capas apiladas, capas recortadas, píxel exacto, degradado, paradas, regiones.
- Licencia del proyecto: GPL-2.0 (impuesta por el motor potrace). Debe constar en la página.

## Brand Commitments

Nombre: image2svg. Voz: precisa, directa, sin jerga innecesaria; explica cada aviso con el problema y la salida. Sin em-dashes en la interfaz.
Compromisos visuales fijados por el usuario (vinculantes): sans con carácter (Manrope o similar del pool permitido) más una mono para cifras y código SVG; neutros fríos (slate) con un solo acento; radios suaves de 8 a 12 px; modo claro y oscuro con detección automática; iconos Phosphor de un solo grosor; vibra premium y elegante; superficie en modo Operate con MOTION_INTENSITY 3.

## Evidence on Hand

- Imágenes sintéticas generadas en código (círculo anti-aliasado, línea diagonal fina, glifo con agujero, tres formas planas, sprite 32×32, logo transparente, ruido tipo foto, plumas con degradado lineal, disco con degradado radial) en `src/dev/synth.ts`.
- Imágenes reales de prueba del usuario (logos que salieron con picos en otros conversores) en `img/`. Solo se muestran resultados obtenidos de verdad con ellas; no fabricar ejemplos "antes y después".
- Sin testimonios, cifras de uso ni comparativas con productos comerciales.

## Product Principles

- La fidelidad se mide, no se afirma: cada resultado lleva su número y su mapa de diferencias.
- Suavizar sin mentir: las esquinas reales se conservan; solo desaparecen los escalones de píxel.
- Todo en local: ninguna imagen sale del navegador.
- Defaults que funcionan: el modo Auto debe dar un buen resultado sin tocar nada; los controles avanzados existen, pero plegados.
- Honestidad con los límites: fotos, trazos finísimos y SVGs enormes se avisan antes de decepcionar.

## Accessibility & Inclusion

Controles operables con teclado (sliders, selects, botones), foco visible, contraste AA en ambos modos, y las métricas también en texto (no solo color). Respeto de `prefers-reduced-motion`.
