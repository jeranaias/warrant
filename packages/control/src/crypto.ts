import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { Warrant, WarrantBody } from "@warrant/contracts";

/**
 * RFC 8785 (JCS) canonical JSON (ADR-005). Our data is strings, safe integers, booleans, null,
 * arrays and plain objects; anything else is a bug and throws. Keys sort by UTF-16 code units,
 * which is JavaScript's default string order. `undefined` object members are omitted.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new Error("canonicalize: only plain objects");
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported ${typeof value}`);
  }
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** sha256 of the canonical JSON, e.g. OwnerApproval.shownHash. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function loadPublicKey(pem: string): KeyObject {
  return createPublicKey(pem);
}

/** Owner signs the canonical WarrantBody. Returns an active Warrant. */
export function signWarrant(body: WarrantBody, privateKey: KeyObject, keyId: string): Warrant {
  const parsed = WarrantBody.parse(body);
  const sig = sign(null, Buffer.from(canonicalize(parsed), "utf8"), privateKey).toString("base64");
  return Warrant.parse({ ...parsed, signature: { alg: "ed25519", keyId, sig }, status: "active" });
}

/** True only if the signature covers exactly this body. Any edited field fails. */
export function verifyWarrant(warrant: Warrant, publicKey: KeyObject): boolean {
  const { signature, status, ...rest } = warrant;
  void status; // not signed: revocation changes status without re-signing
  const body = WarrantBody.safeParse(rest);
  if (!body.success || signature.alg !== "ed25519") return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalize(body.data), "utf8"),
      publicKey,
      Buffer.from(signature.sig, "base64"),
    );
  } catch {
    return false;
  }
}
