// =====================================================================
// CRYPTO MODULE: Web Crypto API (ECDSA, ECDH, AES-256-GCM)
// =====================================================================
const CryptoEngine = {
  // Generate ECDSA keypair for username ownership & signing
  async generateIdentityKeys() {
    const keyPair = await window.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const publicJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const privateJwk = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);
    return { publicJwk, privateJwk };
  },

  // Generate ECDH keypair for pairwise End-to-End Encryption (E2EE)
  async generateEcdhKeys() {
    const keyPair = await window.crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );
    const publicJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const privateJwk = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);
    return { publicJwk, privateJwk };
  },

  // Sign payload using ECDSA private key
  async signData(privateJwk, payloadObj) {
    const key = await window.crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    const enc = new TextEncoder().encode(JSON.stringify(payloadObj));
    const sigBuf = await window.crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      key,
      enc
    );
    return this.bufToBase64(sigBuf);
  },

  // Verify signature using ECDSA public key
  async verifySignature(publicJwk, payloadObj, sigBase64) {
    try {
      const key = await window.crypto.subtle.importKey(
        "jwk",
        publicJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      const enc = new TextEncoder().encode(JSON.stringify(payloadObj));
      const sigBuf = this.base64ToBuf(sigBase64);
      return await window.crypto.subtle.verify(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        key,
        sigBuf,
        enc
      );
    } catch {
      return false;
    }
  },

  // Derive shared AES-256-GCM key between my ECDH private key & peer ECDH public key
  async deriveSharedAesKey(myPrivateJwk, peerPublicJwk) {
    const privKey = await window.crypto.subtle.importKey(
      "jwk",
      myPrivateJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveKey"]
    );
    const pubKey = await window.crypto.subtle.importKey(
      "jwk",
      peerPublicJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    return await window.crypto.subtle.deriveKey(
      { name: "ECDH", public: pubKey },
      privKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  // Encrypt any JSON payload with AES-GCM key
  async encryptWithAesKey(aesKey, dataObj) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(dataObj));
    const cipherBuf = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      encoded
    );
    return {
      iv: this.bufToBase64(iv),
      data: this.bufToBase64(cipherBuf)
    };
  },

  // Decrypt AES-GCM payload
  async decryptWithAesKey(aesKey, encryptedPkg) {
    const iv = this.base64ToBuf(encryptedPkg.iv);
    const cipherBuf = this.base64ToBuf(encryptedPkg.data);
    const plainBuf = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      aesKey,
      cipherBuf
    );
    const decoded = new TextDecoder().decode(plainBuf);
    return JSON.parse(decoded);
  },

  // Derive AES key from PIN + salt for Encrypted Backup File
  async deriveKeyFromPin(pin, saltBase64) {
    const salt = saltBase64
      ? this.base64ToBuf(saltBase64)
      : window.crypto.getRandomValues(new Uint8Array(16));

    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const aesKey = await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: 120000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    return { aesKey, saltBase64: this.bufToBase64(salt) };
  },

  async encryptBackupWithPin(pin, backupObj) {
    const { aesKey, saltBase64 } = await this.deriveKeyFromPin(pin, null);
    const encPkg = await this.encryptWithAesKey(aesKey, backupObj);
    return {
      version: 1,
      salt: saltBase64,
      iv: encPkg.iv,
      data: encPkg.data
    };
  },

  async decryptBackupWithPin(pin, backupFileObj) {
    const { aesKey } = await this.deriveKeyFromPin(pin, backupFileObj.salt);
    return await this.decryptWithAesKey(aesKey, {
      iv: backupFileObj.iv,
      data: backupFileObj.data
    });
  },

  // Create Personal Token hash from identity key + random secret
  async createPersonalToken(publicJwk) {
    const rand = window.crypto.getRandomValues(new Uint8Array(12));
    const raw = JSON.stringify(publicJwk) + ":" + this.bufToBase64(rand);
    const hashBuf = await window.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(raw)
    );
    const hex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return "TOK-" + hex.slice(0, 24).toUpperCase();
  },

  bufToBase64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },

  base64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
};
