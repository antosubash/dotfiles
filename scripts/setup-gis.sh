#!/bin/bash

# GIS workstation setup for Ubuntu: QGIS from the official repository plus the
# command-line toolchain for vector tiles, rasters, OSM, and STAC work.
# Builds on the GDAL/PROJ/GEOS/SpatiaLite base installed by setup-ubuntu.sh.
#
# QGIS_CHANNEL=ltr (default) tracks the long-term release; QGIS_CHANNEL=latest
# tracks the newest release.

set -e

QGIS_CHANNEL="${QGIS_CHANNEL:-ltr}"
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
export PATH="$LOCAL_BIN:$PATH"

# shellcheck source=/dev/null
. /etc/os-release
CODENAME="$VERSION_CODENAME"

case "$QGIS_CHANNEL" in
    ltr)    QGIS_REPO="https://qgis.org/ubuntu-ltr";;
    latest) QGIS_REPO="https://qgis.org/ubuntu";;
    *)      echo "QGIS_CHANNEL must be 'ltr' or 'latest' (got '$QGIS_CHANNEL')" >&2; exit 1;;
esac

echo "Setting up GIS tools on Ubuntu $CODENAME..."

# Latest release tag (e.g. v1.31.2) of a GitHub repository.
latest_tag() {
    curl -fsSL "https://api.github.com/repos/$1/releases/latest" | jq -r .tag_name
}

# QGIS official repository. Ubuntu's archive lags behind and has no LTR channel.
echo "Configuring QGIS $QGIS_CHANNEL repository..."
QGIS_KEYRING=/etc/apt/keyrings/qgis-archive-keyring.gpg
QGIS_SOURCES=/etc/apt/sources.list.d/qgis.sources
if [ ! -f "$QGIS_KEYRING" ]; then
    sudo mkdir -p /etc/apt/keyrings
    sudo wget -qO "$QGIS_KEYRING" https://download.qgis.org/downloads/qgis-archive-keyring.gpg
fi
QGIS_SOURCES_CONTENT="Types: deb deb-src
URIs: $QGIS_REPO
Suites: $CODENAME
Architectures: amd64
Components: main
Signed-By: $QGIS_KEYRING"
if [ "$(cat "$QGIS_SOURCES" 2>/dev/null)" != "$QGIS_SOURCES_CONTENT" ]; then
    echo "$QGIS_SOURCES_CONTENT" | sudo tee "$QGIS_SOURCES" > /dev/null
fi
sudo apt update

# Installing (not just checking) every run upgrades an archive QGIS to the
# qgis.org build once the repository above is in place.
echo "Installing QGIS and GRASS..."
sudo apt install -y qgis qgis-plugin-grass python3-qgis grass

echo "Installing GIS command-line tools..."
GIS_APT_PACKAGES=(
    gdal-bin python3-gdal   # GDAL/OGR (normally already from setup-ubuntu.sh)
    proj-bin                # PROJ CLI
    spatialite-bin          # SpatiaLite CLI
    tippecanoe              # vector tiles (MBTiles/PMTiles) from GeoJSON/FlatGeobuf
    osmium-tool             # OpenStreetMap extracts and filtering
    saga                    # SAGA GIS processing (also used by QGIS Processing)
)
missing=()
for pkg in "${GIS_APT_PACKAGES[@]}"; do
    dpkg -s "$pkg" &> /dev/null || missing+=("$pkg")
done
if [ ${#missing[@]} -gt 0 ]; then
    sudo apt install -y "${missing[@]}"
else
    echo "GIS command-line tools are already installed."
fi

echo "Installing pmtiles CLI..."
if ! command -v pmtiles &> /dev/null; then
    tag="$(latest_tag protomaps/go-pmtiles)"
    curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/$tag/go-pmtiles_${tag#v}_Linux_x86_64.tar.gz" \
        | tar -xz -C "$LOCAL_BIN" pmtiles
else
    echo "pmtiles is already installed."
fi

echo "Installing DuckDB CLI with the spatial extension..."
if ! command -v duckdb &> /dev/null; then
    tag="$(latest_tag duckdb/duckdb)"
    curl -fsSL "https://github.com/duckdb/duckdb/releases/download/$tag/duckdb_cli-linux-amd64.gz" \
        | gunzip > "$LOCAL_BIN/duckdb"
    chmod +x "$LOCAL_BIN/duckdb"
else
    echo "DuckDB is already installed."
fi
duckdb -c "INSTALL spatial;" > /dev/null

echo "Installing Python GIS command-line tools..."
if command -v uv &> /dev/null; then
    # rio-cogeo has no executable of its own; it adds `rio cogeo` to rasterio's CLI.
    uv tool list 2>/dev/null | grep -q '^rasterio ' || uv tool install rasterio --with rio-cogeo
    uv tool list 2>/dev/null | grep -q '^pystac-client ' || uv tool install pystac-client
else
    echo "uv not found (run setup-ubuntu.sh first), skipping rio-cogeo and pystac-client."
fi

echo "Installing mapshaper..."
if ! command -v mapshaper &> /dev/null; then
    if command -v npm &> /dev/null; then
        # Allow just the native-module builds mapshaper needs (GeoPackage/MBTiles
        # via better-sqlite3, fast msgpack) instead of opening install scripts
        # for every global package.
        sudo npm install -g --no-fund --allow-scripts=better-sqlite3,msgpackr-extract mapshaper
    else
        echo "npm not found (run setup-ubuntu.sh first), skipping mapshaper."
    fi
else
    echo "mapshaper is already installed."
fi

echo ""
echo "GIS setup complete:"
echo "  QGIS        $(dpkg-query -W -f='${Version}' qgis)"
echo "  GDAL        $(gdal-config --version 2>/dev/null || gdalinfo --version)"
echo "  tippecanoe  $(tippecanoe --version 2>&1 | head -1)"
echo "  pmtiles     $(pmtiles version 2>&1 | head -1)"
echo "  duckdb      $(duckdb --version)"
