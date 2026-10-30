export type ProxyMode = 'random' | 'sticky';

export interface ParsedProxyUsername {
  baseUsername: string;
  mode: ProxyMode;
  stickyKey: string | null;
}

/** Bucket used by plain `<name>-sticky`; it never ages out. */
export const DEFAULT_STICKY_KEY = 'default';

/** Sticky keys become part of a SOCKS5 username and a database key. */
const STICKY_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * `name` and `name-random` are random; `name-sticky` is the stable default
 * bucket; `name-sticky-<key>` is an independent stable bucket. Keys are
 * lower-cased so UUID spellings do not create duplicate allocations.
 *
 * Exact usernames win only when no base account exists for a suffix, which
 * keeps a literal account called `alice-sticky` usable when `alice` does not.
 */
export function parseProxyUsername(username: string): ParsedProxyUsername {
  const randomSuffix = '-random';
  if (username.length > randomSuffix.length && username.endsWith(randomSuffix)) {
    return {
      baseUsername: username.slice(0, -randomSuffix.length),
      mode: 'random',
      stickyKey: null,
    };
  }

  const stickyMarker = '-sticky';
  const markerAt = username.lastIndexOf(stickyMarker);
  if (markerAt > 0) {
    const suffix = username.slice(markerAt + stickyMarker.length);
    if (suffix === '') {
      return {
        baseUsername: username.slice(0, markerAt),
        mode: 'sticky',
        stickyKey: DEFAULT_STICKY_KEY,
      };
    }
    if (suffix.startsWith('-')) {
      const key = suffix.slice(1);
      if (STICKY_KEY_PATTERN.test(key)) {
        return {
          baseUsername: username.slice(0, markerAt),
          mode: 'sticky',
          stickyKey: key.toLowerCase(),
        };
      }
    }
  }

  return { baseUsername: username, mode: 'random', stickyKey: null };
}
