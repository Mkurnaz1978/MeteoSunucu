param(
    [Parameter(Mandatory = $true)]
    [string]$LocalDemPath,

    [string]$VpsHost = '31.220.94.67',
    [string]$VpsUser = 'root',
    [string]$RemoteAppDir = '/opt/meteo-sunucu',
    [string]$RemoteDemDir = '/opt/meteo-sunucu/data/dem',
    [string]$RemoteClippedDemDir = '/opt/meteo-sunucu/data/dem_clipped'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $LocalDemPath)) {
    throw "Local DEM path not found: $LocalDemPath"
}

Write-Host "Preparing remote DEM directory: $RemoteDemDir"
ssh ${VpsUser}@${VpsHost} "mkdir -p ${RemoteDemDir} ${RemoteClippedDemDir}"

Write-Host 'Uploading GeoTIFF files to VPS (this may take time)...'
scp -r "${LocalDemPath}"/* ${VpsUser}@${VpsHost}:${RemoteDemDir}

Write-Host 'Enabling DEM settings in remote .env and restarting service...'
$remoteCmd = @"
set -e
ENV_FILE='${RemoteAppDir}/.env'
mkdir -p '${RemoteDemDir}'
if [ ! -f "\$ENV_FILE" ]; then
  touch "\$ENV_FILE"
fi

set_or_add() {
  key=\"\$1\"
  value=\"\$2\"
  if grep -q \"^\${key}=\" \"\$ENV_FILE\"; then
    sed -i \"s|^\${key}=.*|\${key}=\${value}|\" \"\$ENV_FILE\"
  else
    echo \"\${key}=\${value}\" >> \"\$ENV_FILE\"
  fi
}

set_or_add DEM_ENABLED true
if command -v gdalwarp >/dev/null 2>&1; then
  chmod +x '${RemoteAppDir}/deploy/clip_dem_to_meteo_bbox.sh'
  '${RemoteAppDir}/deploy/clip_dem_to_meteo_bbox.sh' '${RemoteDemDir}' '${RemoteClippedDemDir}'
  set_or_add DEM_DATA_PATH data/dem_clipped
else
  echo 'UYARI: gdalwarp bulunamadi. DEM kirpma atlandi, ham data/dem kullanilacak.'
  set_or_add DEM_DATA_PATH data/dem
fi

set_or_add DEM_BATCH_MAX_POINTS 500
set_or_add DEM_AGL_ROUND_STEP_FT 100
set_or_add DEM_NODATA_FALLBACK_METERS 0
set_or_add DEM_RESTRICT_TO_METEO_BBOX true

systemctl restart meteo-sunucu
curl -s http://127.0.0.1:3001/dem/health
"@

ssh ${VpsUser}@${VpsHost} $remoteCmd

Write-Host 'DEM upload and activation completed.'
