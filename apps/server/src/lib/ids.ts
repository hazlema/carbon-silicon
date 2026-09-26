export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function newSecret(prefix: string): string {
  return prefix + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export function hashSecret(secret: string): string {
  return new Bun.CryptoHasher('sha256').update(secret).digest('hex');
}
