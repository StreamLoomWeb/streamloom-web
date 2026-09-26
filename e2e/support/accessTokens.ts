/**
 * A throwaway RSA keypair and a JWT minter, so the Access gate can be attacked in
 * a test without any Cloudflare account, network or fixture token.
 *
 * Everything here uses WebCrypto, which is the same API the Function itself uses,
 * so a token this file signs is byte-for-byte the shape Access produces.
 */

export interface TestKey {
  kid: string
  privateKey: CryptoKey
  /** Public JWK as it appears in a `/cdn-cgi/access/certs` response. */
  jwk: Record<string, unknown>
}

export async function makeTestKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair

  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid },
  }
}

/** A JWKS document with the given keys, as the certs endpoint serves it. */
export function jwks(...keys: TestKey[]): string {
  return JSON.stringify({ keys: keys.map((k) => k.jwk) })
}

function b64u(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface TokenOptions {
  key: TestKey
  payload: Record<string, unknown>
  /** Overrides the header. Used to forge `alg: none`, a wrong `kid`, and so on. */
  header?: Record<string, unknown>
  /** Replaces the signature with this literal value instead of signing. */
  rawSignature?: string
}

/** Signs a JWT with `key`, or forges one when `rawSignature` is given. */
export async function mintToken({ key, payload, header, rawSignature }: TokenOptions): Promise<string> {
  const head = b64u(JSON.stringify(header ?? { alg: 'RS256', typ: 'JWT', kid: key.kid }))
  const body = b64u(JSON.stringify(payload))
  if (rawSignature !== undefined) return `${head}.${body}.${rawSignature}`
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      key.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    ),
  )
  return `${head}.${body}.${b64u(signature)}`
}

/** A payload Access would produce: correct issuer, audience, identity and lifetime. */
export function validPayload(
  teamDomain: string,
  aud: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const nowS = Math.floor(Date.now() / 1000)
  return {
    iss: teamDomain,
    aud: [aud],
    exp: nowS + 3600,
    iat: nowS - 10,
    nbf: nowS - 10,
    sub: 'test-subject',
    email: 'owner@example.com',
    ...overrides,
  }
}
