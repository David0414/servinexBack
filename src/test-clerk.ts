import { generateKeyPairSync, sign } from "node:crypto";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
export const clerkTestConfig = {
  CLERK_SECRET_KEY: "sk_test_not_a_real_key",
  CLERK_ISSUER: "https://test-instance.clerk.accounts.dev",
  CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
};
export function clerkTestToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: "user_TestStaff123",
    sid: "sess_TestSession123",
    iss: clerkTestConfig.CLERK_ISSUER,
    azp: "https://app.example.test",
    iat: now,
    nbf: now - 1,
    exp: now + 3600,
    ...overrides,
  };
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signed = `${header}.${body}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}
