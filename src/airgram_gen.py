#!/usr/bin/env python3
"""
AIRGRAM PNG generator for ERAH MeteoSunucu.
Reads JSON from stdin, writes PNG bytes to stdout.

Install deps on VPS:  pip3 install matplotlib numpy
"""

import sys
import json
import math
import io
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import matplotlib.ticker as ticker
from matplotlib.patches import FancyArrowPatch
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def safe_float(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else np.nan
    except Exception:
        return np.nan


def safe_list(lst, n):
    result = [safe_float(lst[i]) if i < len(lst) else np.nan for i in range(n)]
    return np.array(result, dtype=float)


def fill_nans(arr):
    """Linear interpolation across NaN gaps."""
    nans = np.isnan(arr)
    if not nans.any():
        return arr.copy()
    xs = np.arange(len(arr))
    valid = ~nans
    if not valid.any():
        return np.zeros_like(arr)
    return np.interp(xs, xs[valid], arr[valid])


def parse_iso(s):
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Wind barb drawing helper
# ---------------------------------------------------------------------------

def draw_barb(ax, x, y, speed_kt, dir_deg,
              barb_length=5, color='#00C853', linewidth=0.7):
    """
    Draws a single wind barb on ax at (x, y).
    Convention: barb tail points INTO the wind.
    """
    if np.isnan(speed_kt) or np.isnan(dir_deg) or speed_kt < 1:
        # Calm: circle
        ax.plot(x, y, 'o', color=color, markersize=3, linewidth=linewidth)
        return

    # Meteorological convention: dir_deg is FROM (so wind vector points in dir_deg+180)
    dir_rad = math.radians(dir_deg)
    # Shaft points FROM the wind direction (tail is upwind)
    u = math.sin(dir_rad)
    v = math.cos(dir_rad)

    ax.barbs([x], [y], [-u * speed_kt], [-v * speed_kt],
             length=barb_length,
             barbcolor=color,
             flagcolor=color,
             linewidth=linewidth,
             sizes=dict(height=0.4, width=0.3, emptybarb=0.15),
             zorder=3)


# ---------------------------------------------------------------------------
# Time axis styling
# ---------------------------------------------------------------------------

TR_DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz']


def style_time_axis(ax, times_dt, n, add_day_labels=True):
    """
    Set x-axis ticks and grid lines.  X axis = hour index (0..n-1).
    """
    tick_positions = []
    tick_labels = []
    day_boundary_xs = []
    day_names = []

    for i, t in enumerate(times_dt):
        if t is None:
            continue
        if t.hour % 6 == 0:
            tick_positions.append(i)
            tick_labels.append(f'{t.hour:02d}')
        if t.hour == 0:
            day_boundary_xs.append(i)
            day_names.append(TR_DAYS[t.weekday()])

    ax.set_xlim(0, max(n - 1, 1))
    ax.set_xticks(tick_positions)
    ax.set_xticklabels(tick_labels, fontsize=7)
    ax.tick_params(axis='x', labelrotation=0)

    for db in day_boundary_xs:
        ax.axvline(db, color='#555', linewidth=0.9, linestyle='--', alpha=0.7, zorder=5)

    if add_day_labels:
        ylims = ax.get_ylim()
        y_top = ylims[1]
        y_range = ylims[1] - ylims[0]
        for db, name in zip(day_boundary_xs, day_names):
            ax.text(db + 0.3, y_top - y_range * 0.05, name,
                    fontsize=7, color='#444', ha='left', va='top', zorder=6)

    ax.grid(axis='x', color='#ccc', linewidth=0.4, linestyle=':', alpha=0.7)
    ax.grid(axis='y', color='#eee', linewidth=0.3)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    data = json.load(sys.stdin)

    station_code = str(data.get('station', 'LTFC'))
    station_name = str(data.get('name', station_code))
    lat = float(data.get('lat', 37.85))
    lon = float(data.get('lon', 30.37))
    surface = data.get('surface', {})
    aloft = data.get('aloft', {})

    times_str = surface.get('time', [])
    n = len(times_str)
    if n == 0:
        print('ERROR: no time data', file=sys.stderr)
        sys.exit(1)

    times_dt = [parse_iso(s) for s in times_str]
    t_idx = np.arange(n, dtype=float)

    # ------------------------------------------------------------------
    # Surface fields
    # ------------------------------------------------------------------
    temp2  = safe_list(surface.get('temperature_2m', []), n)
    dew2   = safe_list(surface.get('dew_point_2m', []), n)
    wspd   = safe_list(surface.get('wind_speed_10m', []), n)   # knots
    wdir   = safe_list(surface.get('wind_direction_10m', []), n)
    qnh    = safe_list(surface.get('surface_pressure', []), n) # hPa
    precip = safe_list(surface.get('precipitation', []), n)    # mm
    cloud  = safe_list(surface.get('cloud_cover', []), n)      # %

    # ------------------------------------------------------------------
    # Pressure level fields
    # Levels used: 925->~2500ft, 850->~5000ft, 700->~10000ft,
    #              500->~18000ft, 400->~24000ft, 300->~30000ft
    # ------------------------------------------------------------------
    LEVELS = [
        ('925', 2500,  '~2500ft'),
        ('850', 5000,  '~5000ft'),
        ('700', 10000, '~10000ft'),
        ('500', 18000, '~18000ft'),
        ('400', 24000, '~24000ft'),
        ('300', 30000, '~30000ft'),
    ]

    alt_fts  = [ft for _, ft, _ in LEVELS]
    temp850  = safe_list(aloft.get('temperature_850hPa', []), n)

    aloft_t  = {ft: fill_nans(safe_list(aloft.get(f'temperature_{hpa}hPa', []), n))
                for hpa, ft, _ in LEVELS}
    aloft_ws = {ft: safe_list(aloft.get(f'wind_speed_{hpa}hPa', []), n)
                for hpa, ft, _ in LEVELS}
    aloft_wd = {ft: safe_list(aloft.get(f'wind_direction_{hpa}hPa', []), n)
                for hpa, ft, _ in LEVELS}

    # Surface temperature also filled for vertical grid
    temp2_f = fill_nans(temp2)

    # ------------------------------------------------------------------
    # Build vertical temperature grid (levels x times)
    # ------------------------------------------------------------------
    v_alts = np.array([0] + alt_fts, dtype=float)   # 7 levels
    v_temp = np.vstack([temp2_f[np.newaxis, :]] +
                       [aloft_t[ft][np.newaxis, :] for ft in alt_fts])  # (7, n)
    # Fill any remaining NaN column-wise
    for col in range(v_temp.shape[1]):
        col_vals = v_temp[:, col]
        nans = np.isnan(col_vals)
        if nans.any() and not nans.all():
            xs = np.arange(len(v_alts))
            v_temp[:, col] = np.interp(xs, xs[~nans], col_vals[~nans])

    # ------------------------------------------------------------------
    # Figure layout
    # ------------------------------------------------------------------
    fig = plt.figure(figsize=(16, 15), facecolor='white', dpi=110)
    fig.suptitle('AIRGRAM', fontsize=17, fontweight='bold', y=0.995)

    gs = gridspec.GridSpec(
        4, 1, figure=fig,
        hspace=0.40,
        top=0.965, bottom=0.04,
        left=0.07, right=0.96,
        height_ratios=[1.2, 1.0, 2.2, 1.2],
    )

    ax1 = fig.add_subplot(gs[0])   # Wind + QNH
    ax2 = fig.add_subplot(gs[1])   # Surface temps
    ax3 = fig.add_subplot(gs[2])   # Vertical section
    ax4 = fig.add_subplot(gs[3])   # Cloud + Precip

    # ------------------------------------------------------------------
    # Panel 1 – Yer Rüzgarı(knot) + QNH(mb)
    # ------------------------------------------------------------------
    ax1.set_title('Yer Rüzgarı(knot) — QNH(mb)', fontsize=9, loc='left', pad=4)

    # Wind speed line
    wspd_f = fill_nans(wspd)
    ax1.plot(t_idx, wspd_f, color='#2196F3', linewidth=1.3, label='Rüzgar(kt)', zorder=4)

    # Wind barbs (every 3 hours)
    barb_step = max(1, n // 48)
    for i in range(0, n, barb_step):
        draw_barb(ax1, float(i), float(wspd_f[i]) * 0.35 + 1,
                  wspd[i], wdir[i],
                  barb_length=5, color='#90CAF9', linewidth=0.8)

    wspd_max = max(np.nanmax(wspd_f) * 1.3, 20.0)
    ax1.set_ylim(0, wspd_max)
    ax1.set_ylabel('knot', fontsize=8)

    # QNH – right axis (green)
    ax1r = ax1.twinx()
    qnh_f = fill_nans(qnh)
    if not np.all(np.isnan(qnh)):
        ax1r.plot(t_idx, qnh_f, color='green', linewidth=1.5, label='QNH', zorder=5)
        qnh_margin = max(5.0, (np.nanmax(qnh_f) - np.nanmin(qnh_f)) * 0.5)
        ax1r.set_ylim(np.nanmin(qnh_f) - qnh_margin, np.nanmax(qnh_f) + qnh_margin)
        ax1r.set_ylabel('mb', fontsize=8, color='green')
        ax1r.tick_params(axis='y', colors='green', labelsize=7)

    # Legend
    lines1 = [plt.Line2D([0], [0], color='#2196F3', lw=1.3, label='Rüzgar'),
              plt.Line2D([0], [0], color='green', lw=1.5, label='QNH')]
    ax1.legend(handles=lines1, loc='upper right', fontsize=7, ncol=2)

    style_time_axis(ax1, times_dt, n)

    # ------------------------------------------------------------------
    # Panel 2 – Yer Sıcaklıkları(°C) + T850
    # ------------------------------------------------------------------
    ax2.set_title('Yer Sıcaklıkları(°C) — 850mb Sıcaklık(°C)', fontsize=9, loc='left', pad=4)

    temp2_f2 = fill_nans(temp2)
    dew2_f   = fill_nans(dew2)
    t850_f   = fill_nans(temp850)

    ax2.plot(t_idx, temp2_f2, color='red',   linewidth=1.5, label='T2')
    ax2.plot(t_idx, dew2_f,   color='blue',  linewidth=1.2, label='TD2')
    if not np.all(np.isnan(temp850)):
        ax2.plot(t_idx, t850_f, color='green', linewidth=1.2,
                 linestyle='--', label='T850')
    ax2.axhline(0, color='#aaa', linewidth=0.7, linestyle=':')
    ax2.set_ylabel('°C', fontsize=8)

    # Annotate latest values
    last_t2 = temp2_f2[~np.isnan(temp2_f2)][-1] if not np.all(np.isnan(temp2_f2)) else None
    if last_t2 is not None:
        ax2.annotate(f'{last_t2:.0f}', xy=(n - 1, last_t2), fontsize=7,
                     color='red', xytext=(3, 0), textcoords='offset points')

    ax2.legend(loc='upper right', fontsize=7, ncol=3)
    style_time_axis(ax2, times_dt, n)

    # ------------------------------------------------------------------
    # Panel 3 – Düşey Sıcaklık(°C) — Rüzgar(knot)
    # ------------------------------------------------------------------
    ax3.set_title('Düşey Sıcaklık(°C) — Rüzgar(knot)', fontsize=9, loc='left', pad=4)

    # Color-fill: temperature cross section
    XX = np.tile(t_idx, (len(v_alts), 1))           # (7, n)
    YY = np.tile(v_alts[:, np.newaxis], (1, n))      # (7, n)
    cmap = plt.cm.RdBu_r
    pcm = ax3.pcolormesh(XX, YY, v_temp, cmap=cmap,
                          vmin=-70, vmax=40,
                          shading='gouraud', zorder=1)

    # Thin horizontal guide lines at each pressure level altitude
    for ft in alt_fts:
        ax3.axhline(ft, color='white', linewidth=0.4, linestyle='-', alpha=0.3, zorder=2)

    # Isotherm contour lines
    try:
        cs = ax3.contour(t_idx, v_alts, v_temp,
                         levels=[-60, -50, -40, -30, -20, -10, 0, 10, 20],
                         colors=['#222222'],
                         linewidths=0.7,
                         linestyles='--',
                         zorder=3)
        # 0°C isotherm special (blue, solid, thicker)
        cs0 = ax3.contour(t_idx, v_alts, v_temp,
                          levels=[0],
                          colors=['blue'],
                          linewidths=1.5,
                          linestyles='-',
                          zorder=4)
        ax3.clabel(cs,  fmt='%d°', fontsize=6, inline=True)
        ax3.clabel(cs0, fmt='0°C', fontsize=7, inline=True, colors='blue')
    except Exception as e:
        print(f'Contour warning: {e}', file=sys.stderr)

    # Wind barbs at each pressure level
    barb_step3 = max(1, n // 36)
    for ft in alt_fts:
        for i in range(0, n, barb_step3):
            draw_barb(ax3, float(i), float(ft),
                      aloft_ws[ft][i], aloft_wd[ft][i],
                      barb_length=5, color='#00E676', linewidth=0.7)

    # Y axis labels in ft x1000
    yticks_ft = [0, 5000, 10000, 15000, 20000, 25000, 30000]
    ax3.set_yticks(yticks_ft)
    ax3.set_yticklabels([f'{v//1000}' for v in yticks_ft], fontsize=8)
    ax3.set_ylim(0, 32000)
    ax3.set_ylabel('ft (x1000)', fontsize=8)

    # Colorbar
    cb = plt.colorbar(pcm, ax=ax3, orientation='vertical',
                      fraction=0.02, pad=0.01, shrink=0.85)
    cb.set_label('°C', fontsize=7)
    cb.ax.tick_params(labelsize=6)

    style_time_axis(ax3, times_dt, n)

    # ------------------------------------------------------------------
    # Panel 4 – Bulut Kapalılığı(%) + Yağış(mm)
    # ------------------------------------------------------------------
    ax4.set_title('Bulut Kapalılığı(%) — Yağış(mm)', fontsize=9, loc='left', pad=4)

    cloud_f = fill_nans(cloud)
    ax4.fill_between(t_idx, 0, cloud_f, alpha=0.35, color='#78909C', label='Bulut(%)', zorder=2)
    ax4.plot(t_idx, cloud_f, color='#37474F', linewidth=0.9, zorder=3)
    ax4.set_ylim(0, 110)
    ax4.set_ylabel('%', fontsize=8)
    ax4.set_yticks([0, 25, 50, 75, 100])

    # Precipitation – right axis
    ax4r = ax4.twinx()
    precip_clean = np.where(np.isnan(precip), 0.0, precip)
    if np.any(precip_clean > 0.01):
        ax4r.bar(t_idx, precip_clean, color='#5C6BC0', alpha=0.75,
                 width=0.8, label='Yağış(mm)', zorder=4)
        pmax = max(np.nanmax(precip_clean) * 4, 5.0)
        ax4r.set_ylim(0, pmax)
        ax4r.set_ylabel('mm', fontsize=8, color='#5C6BC0')
        ax4r.tick_params(axis='y', colors='#5C6BC0', labelsize=7)

    # Legend
    lines4 = [plt.Rectangle((0,0),1,1, color='#78909C', alpha=0.5, label='Bulut(%)'),
              plt.Rectangle((0,0),1,1, color='#5C6BC0', alpha=0.75, label='Yağış(mm)')]
    ax4.legend(handles=lines4, loc='upper right', fontsize=7, ncol=2)

    style_time_axis(ax4, times_dt, n)

    # ------------------------------------------------------------------
    # Şu anki zamanın dikey çizgisi (current time vertical line)
    # ------------------------------------------------------------------
    now_utc_dt = datetime.now(timezone.utc)
    if times_dt[0] is not None:
        start_time = times_dt[0]
        if start_time.tzinfo is None:
            start_time = start_time.replace(tzinfo=timezone.utc)
        
        # Zaman farkını saat cinsinden hesapla
        time_diff = now_utc_dt - start_time
        hours_elapsed = time_diff.total_seconds() / 3600.0
        
        # Mevcut saat index'i grafiğin alanı içinde ise çizgiyi ekle
        if 0 <= hours_elapsed < n:
            for ax in [ax1, ax2, ax3, ax4]:
                ax.axvline(hours_elapsed, color='#FF0000', linewidth=2.8, 
                          linestyle='-', alpha=0.85, zorder=15)

    # ------------------------------------------------------------------
    # Header
    # ------------------------------------------------------------------
    now_utc = datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M UTC')
    header = (f'{station_code} — {station_name}\n'
              f'{abs(lat):.2f}{"N" if lat >= 0 else "S"}  '
              f'{abs(lon):.2f}{"E" if lon >= 0 else "W"}\n'
              f'Open-Meteo / WGS84')
    fig.text(0.005, 0.988, header,
             fontsize=8, va='top', family='monospace',
             bbox=dict(boxstyle='round,pad=0.3', facecolor='white',
                       edgecolor='#aaa', alpha=0.9))
    fig.text(0.78, 0.988, f'© ERAH\n{now_utc}\nOpen-Meteo Forecast',
             fontsize=8, va='top', ha='left')

    # ------------------------------------------------------------------
    # Output PNG to stdout
    # ------------------------------------------------------------------
    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=120,
                bbox_inches='tight', facecolor='white', edgecolor='none')
    plt.close(fig)
    buf.seek(0)
    sys.stdout.buffer.write(buf.read())


if __name__ == '__main__':
    main()
