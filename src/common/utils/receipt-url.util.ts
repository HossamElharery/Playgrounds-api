const ALLOWED_EXT = /\.(jpe?g|png|webp|pdf)$/i;

function hasControlOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || value[i] === '\\') return true;
  }
  return false;
}

/**
 * Receipts must be files we stored ourselves: a `/uploads/...` path (or the
 * configured public storage base) with a safe image/PDF extension, no query
 * string, fragment, traversal, or protocol-relative tricks.
 */
export function isSafeReceiptUrl(url: string, publicBase?: string): boolean {
  if (!url || url.length > 500 || hasControlOrBackslash(url)) return false;
  let path: string;
  if (url.startsWith('/uploads/')) {
    path = url;
  } else if (publicBase && url.startsWith(publicBase)) {
    path = url.slice(publicBase.length);
    if (!path.startsWith('/')) path = `/${path}`;
  } else {
    return false;
  }
  if (/[?#]/.test(path)) return false;
  if (path.includes('//') || path.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  return ALLOWED_EXT.test(path);
}
