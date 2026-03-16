/**
 * Weather icon helper for satori infographic rendering.
 * Uses lucide icon path data (already installed) as plain SVG elements
 * since lucide-react components use forwardRef which satori can't handle.
 */

import React from 'react';

type IconNode = [string, Record<string, string>][];

/** Lucide icon SVG path data, keyed by icon name */
const ICONS: Record<string, IconNode> = {
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 2v2' }],
    ['path', { d: 'M12 20v2' }],
    ['path', { d: 'm4.93 4.93 1.41 1.41' }],
    ['path', { d: 'm17.66 17.66 1.41 1.41' }],
    ['path', { d: 'M2 12h2' }],
    ['path', { d: 'M20 12h2' }],
    ['path', { d: 'm6.34 17.66-1.41 1.41' }],
    ['path', { d: 'm19.07 4.93-1.41 1.41' }],
  ],
  cloudSun: [
    ['path', { d: 'M12 2v2' }],
    ['path', { d: 'm4.93 4.93 1.41 1.41' }],
    ['path', { d: 'M20 12h2' }],
    ['path', { d: 'm19.07 4.93-1.41 1.41' }],
    ['path', { d: 'M15.947 12.65a4 4 0 0 0-5.925-4.128' }],
    ['path', { d: 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z' }],
  ],
  cloudFog: [
    ['path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
    ['path', { d: 'M16 17H7' }],
    ['path', { d: 'M17 21H9' }],
  ],
  cloudDrizzle: [
    ['path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
    ['path', { d: 'M8 19v1' }],
    ['path', { d: 'M8 14v1' }],
    ['path', { d: 'M16 19v1' }],
    ['path', { d: 'M16 14v1' }],
    ['path', { d: 'M12 21v1' }],
    ['path', { d: 'M12 16v1' }],
  ],
  cloudRain: [
    ['path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
    ['path', { d: 'M16 14v6' }],
    ['path', { d: 'M8 14v6' }],
    ['path', { d: 'M12 16v6' }],
  ],
  cloudSnow: [
    ['path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
    ['path', { d: 'M8 15h.01' }],
    ['path', { d: 'M8 19h.01' }],
    ['path', { d: 'M12 17h.01' }],
    ['path', { d: 'M12 21h.01' }],
    ['path', { d: 'M16 15h.01' }],
    ['path', { d: 'M16 19h.01' }],
  ],
  cloudRainWind: [
    ['path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
    ['path', { d: 'm9.2 22 3-7' }],
    ['path', { d: 'm9 13-3 7' }],
    ['path', { d: 'm17 13-3 7' }],
  ],
  snowflake: [
    ['line', { x1: '2', x2: '22', y1: '12', y2: '12' }],
    ['line', { x1: '12', x2: '12', y1: '2', y2: '22' }],
    ['path', { d: 'm20 16-4-4 4-4' }],
    ['path', { d: 'm4 8 4 4-4 4' }],
    ['path', { d: 'm16 4-4 4-4-4' }],
    ['path', { d: 'm8 20 4-4 4 4' }],
  ],
  cloudLightning: [
    ['path', { d: 'M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973' }],
    ['path', { d: 'm13 12-3 5h4l-3 5' }],
  ],
  flame: [
    ['path', { d: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z' }],
  ],
  droplet: [
    ['path', { d: 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z' }],
  ],
};

/**
 * Get a satori-compatible SVG arrow icon for wind direction (in degrees).
 * Arrow points in the direction the wind is blowing FROM (meteorological convention).
 */
export function getWindArrowIcon(degrees: number, size = 24, color = 'white'): React.ReactElement {
  // Arrow pointing up = North (0°). Rotate by degrees to show wind-from direction.
  return React.createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { transform: `rotate(${degrees}deg)` },
  },
    React.createElement('path', { d: 'M12 19V5' }),
    React.createElement('path', { d: 'm5 12 7-7 7 7' }),
  );
}

/** Get a calm/no-wind icon (small circle). */
export function getWindCalmIcon(size = 24, color = 'white'): React.ReactElement {
  return React.createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
  },
    React.createElement('circle', { cx: '12', cy: '12', r: '3' }),
  );
}

/** Get a satori-compatible UV sun icon (lucide sun-dim). */
export function getUvIcon(size = 24, color = '#f0c040'): React.ReactElement {
  const nodes: IconNode = [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 4V2' }],
    ['path', { d: 'M12 22v-2' }],
    ['path', { d: 'm4.93 4.93 1.41 1.41' }],
    ['path', { d: 'm17.66 17.66 1.41 1.41' }],
    ['path', { d: 'M2 12h2' }],
    ['path', { d: 'M20 12h2' }],
    ['path', { d: 'm6.34 17.66-1.41 1.41' }],
    ['path', { d: 'm19.07 4.93-1.41 1.41' }],
  ];
  const children = nodes.map(([tag, attrs], i) =>
    React.createElement(tag, { ...attrs, key: String(i) })
  );
  return React.createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, ...children);
}

/** Get a satori-compatible humidity droplet icon. */
export function getHumidityIcon(size = 24, color = '#64b5f6'): React.ReactElement {
  const nodes = ICONS.droplet;
  const children = nodes.map(([tag, attrs], i) =>
    React.createElement(tag, { ...attrs, key: String(i) })
  );
  return React.createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, ...children);
}

/** WMO weather code → lucide icon name. Code -1 = flame (sharav). */
function getIconName(code: number): string {
  if (code === -1) return 'flame';
  if (code === 0) return 'sun';
  if (code <= 3) return 'cloudSun';
  if (code <= 48) return 'cloudFog';
  if (code <= 57) return 'cloudDrizzle';
  if (code <= 67) return 'cloudRain';
  if (code <= 77) return 'cloudSnow';
  if (code <= 82) return 'cloudRainWind';
  if (code <= 86) return 'snowflake';
  return 'cloudLightning';
}

/**
 * Get a satori-compatible SVG icon element for a WMO weather code.
 * Use code -1 for the flame (sharav) icon.
 */
export function getWeatherIcon(code: number, size = 48, color = 'white'): React.ReactElement {
  const nodes = ICONS[getIconName(code)] || ICONS.sun;
  const children = nodes.map(([tag, attrs], i) =>
    React.createElement(tag, { ...attrs, key: String(i) })
  );
  return React.createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, ...children);
}
