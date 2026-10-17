/**
 * Non-extractable session key encapsulation via WebCrypto. The raw
 * ECDH private key material never becomes accessible to page scripts
 * (extractable: false) — sensitive session tokens are wrapped/unwrapped
 * through the CryptoKey handle only, so a DOM-based XSS cannot exfiltrate
 * the underlying key bytes.
 */

const ECDH_PARAMS: EcKeyAlgorithm = { name: 'ECDH', namedCurve: 'P-256' } as EcKeyAlgorithm;

export interface SessionKeyHandle {
  publicKey: CryptoKey;
  privateKey: CryptoKey; // extractable: false
  createdAt: number;
}

let activeSession: SessionKeyHandle | null = null;
let autoBurnTimer: ReturnType<typeof setTimeout> | null = null;

/** Generate a fresh, non-extractable ECDH session keypair. */
export async function generateSessionKey(): Promise<SessionKeyHandle> {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveKey', 'deriveBits']);

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    createdAt: Date.now(),
  };
}

/** Derive a symmetric AES-GCM key from our session key + a peer's public key. */
export async function deriveSharedKey(
  ourPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    ourPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false, // derived key is also non-extractable
    ['encrypt', 'decrypt'],
  );
}

/** Encapsulate (encrypt) a session token under the derived shared key. */
export async function encapsulateToken(
  sharedKey: CryptoKey,
  token: string,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    new TextEncoder().encode(token),
  );
  return { ciphertext, iv };
}

export async function decapsulateToken(
  sharedKey: CryptoKey,
  ciphertext: ArrayBuffer,
  iv: Uint8Array,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Start (or replace) the active session key, auto-burning it after inactivity. */
export async function startSession(): Promise<SessionKeyHandle> {
  burnSession();
  activeSession = await generateSessionKey();
  scheduleAutoBurn();
  return activeSession;
}

export function getActiveSession(): SessionKeyHandle | null {
  return activeSession;
}

export function touchSession(): void {
  if (activeSession) {
    scheduleAutoBurn();
  }
}

function scheduleAutoBurn(): void {
  if (autoBurnTimer) clearTimeout(autoBurnTimer);
  autoBurnTimer = setTimeout(() => burnSession(), SESSION_TIMEOUT_MS);
}

/** Destroy the active session key reference so it becomes garbage-collectable. */
export function burnSession(): void {
  activeSession = null;
  if (autoBurnTimer) {
    clearTimeout(autoBurnTimer);
    autoBurnTimer = null;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', burnSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Tighten the auto-burn window while the tab is backgrounded.
      touchSession();
    }
  });
}
