/**
 * The client's address for the sign-in limits (web sign-in spec §5). It is the `x-real-ip` header Railway's edge sets,
 * as the zmanim pages' limit reads it (proxy.ts); never X-Forwarded-For, which the client can write. Before launch one
 * real request confirms that Railway overwrites a value the client sends.
 *
 * An IPv6 address counts by its /64, the block one home or phone line gets, so changing the last 64 bits buys no new
 * count. An IPv4-mapped IPv6 address (::ffff:192.0.2.7) counts as its IPv4 address. Pure: no I/O.
 */

import { isIP } from 'net';

/** The address to count by: an IPv4 address, or an IPv6 /64 written `a:b:c:d::/64`; null when the header is missing or not an address. */
export function clientAddress(request: Request): string | null {
  const raw = request.headers.get('x-real-ip')?.trim() ?? '';
  if (raw === '') return null;
  const kind = isIP(raw);
  if (kind === 4) return raw;
  if (kind === 6) return ipv6Block(raw);
  return null;
}

/** The /64 of an IPv6 address `isIP` accepted (any compression, an embedded IPv4, a %zone), or the IPv4 address it maps. */
function ipv6Block(address: string): string | null {
  const bare = address.split('%')[0].toLowerCase();
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  // An embedded IPv4 address (the last 32 bits written 192.0.2.7) is two groups
  const last = halves.length === 2 ? tail : head;
  if (last.length > 0 && last[last.length - 1].includes('.')) {
    const [a, b, c, d] = last.pop()!.split('.').map(Number);
    last.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const gap = 8 - head.length - tail.length;
  if (halves.length === 2 ? gap < 1 : gap !== 0) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? gap : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}
