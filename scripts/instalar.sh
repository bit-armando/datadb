#!/bin/bash
#
# Compila e instala la app en /Applications (decisión del usuario, 2026-10-20: «me la puedes
# compilar e instalar por cada cambio»). Es el bucle de trabajo: `npm run instalar`.
#
# POR QUÉ `--dir` Y NO EL `.dmg`: el `.dmg` comprime 145 MB para poder compartir la app; para
# probar cada cambio eso es tiempo perdido. `--dir` deja el mismo `.app` en `release/mac-arm64/`
# en una fracción del tiempo, y `ditto` lo copia tal cual (conserva permisos, symlinks y firmas;
# `cp -R` puede romper el bundle).
#
# ORDEN IMPRESCINDIBLE: cerrar la app ANTES de copiar. Con la app abierta, `ditto` escribe debajo de
# un proceso vivo: quedan binarios a medio reemplazar y Electron arranca con la versión anterior o
# muere al cargar el renderer.
set -euo pipefail

APP_ID="mx.datadb.app"
DESTINO="/Applications/DataDB.app"
ORIGEN="release/mac-arm64/DataDB.app"

cd "$(dirname "$0")/.."

echo "▸ construyendo…"
npm run build >/tmp/datadb-build.log 2>&1 || { tail -20 /tmp/datadb-build.log; exit 1; }

echo "▸ empaquetando (dir, sin dmg)…"
npx electron-builder --mac dir --arm64 >/tmp/datadb-builder.log 2>&1 || { tail -30 /tmp/datadb-builder.log; exit 1; }

if [ ! -d "$ORIGEN" ]; then
  echo "✖ no apareció $ORIGEN"; exit 1
fi

# Cierre ordenado: la app guarda su estado al salir (pestañas, layouts). Si no cierra en 10 s se
# fuerza, pero se avisa: forzar puede perder el estado de la sesión.
if pgrep -f "$DESTINO/Contents/MacOS/DataDB" >/dev/null 2>&1; then
  echo "▸ cerrando la app…"
  osascript -e 'tell application id "'"$APP_ID"'" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -f "$DESTINO/Contents/MacOS/DataDB" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -f "$DESTINO/Contents/MacOS/DataDB" >/dev/null 2>&1; then
    echo "  ⚠ no cerró en 10 s: se termina el proceso"
    pkill -f "$DESTINO/Contents/MacOS/DataDB" || true
    sleep 1
  fi
fi

echo "▸ instalando en ${DESTINO}…"
rm -rf "$DESTINO"
ditto "$ORIGEN" "$DESTINO"

# Sin firma de Apple, la copia local no queda en cuarentena (la cuarentena la pone la descarga),
# pero se limpia por si el bundle venía de un dmg bajado.
xattr -dr com.apple.quarantine "$DESTINO" 2>/dev/null || true

# Evita que Spotlight y LaunchServices indexen el bundle temporal de compilación como una segunda DataDB.app.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -u "$PWD/$ORIGEN" >/dev/null 2>&1 || true
fi
rm -rf "$ORIGEN"

echo "▸ abriendo…"
open -a "$DESTINO"

echo "✔ instalado $(date '+%H:%M:%S') · $(du -sh "$DESTINO" | cut -f1) · $(stat -f '%Sm' "$DESTINO")"
