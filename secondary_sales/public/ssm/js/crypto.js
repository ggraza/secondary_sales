// AES-GCM encryption of everything the app stores on the device.
// The key comes from the server (per user, rotatable) and is imported as a
// non-extractable CryptoKey, so page scripts can use it but never read it.

const ALG = "AES-GCM";

function b64ToBytes(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function importKey(base64Key) {
	const raw = b64ToBytes(base64Key);
	if (raw.length !== 32) throw new Error("Device key must be 256 bits");
	return crypto.subtle.importKey("raw", raw, { name: ALG }, false, ["encrypt", "decrypt"]);
}

export async function encryptJSON(key, value) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(JSON.stringify(value));
	const ct = await crypto.subtle.encrypt({ name: ALG, iv }, key, data);
	return { iv, ct: new Uint8Array(ct) };
}

export async function decryptJSON(key, record) {
	const pt = await crypto.subtle.decrypt({ name: ALG, iv: record.iv }, key, record.ct);
	return JSON.parse(new TextDecoder().decode(pt));
}
