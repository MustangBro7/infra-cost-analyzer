import test from "node:test"
import assert from "node:assert/strict"
import { sigv4Sign } from "../src/lib/awsClient"

// AWS SigV4 "get-vanilla" documented test vector. Validates that our signing
// (canonical request, string-to-sign, signing key, signature) is correct.
// https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
test("sigv4Sign matches the AWS get-vanilla test vector", async () => {
  const result = await sigv4Sign({
    method: "GET",
    host: "example.amazonaws.com",
    path: "/",
    query: "",
    headers: {},
    payload: "",
    service: "service",
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    },
    amzDate: "20150830T123600Z",
    dateStamp: "20150830",
  })

  assert.equal(result.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31")
  assert.match(
    result.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/
  )
})

test("sigv4Sign includes the session token header when present", async () => {
  const result = await sigv4Sign({
    method: "POST",
    host: "freetier.us-east-1.amazonaws.com",
    path: "/",
    query: "",
    headers: { "x-amz-target": "AWSFreeTierService.GetFreeTierUsage" },
    payload: "{}",
    service: "freetier",
    region: "us-east-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret", sessionToken: "token-123" },
    amzDate: "20240101T000000Z",
    dateStamp: "20240101",
  })
  assert.equal(result.headers["x-amz-security-token"], "token-123")
  assert.match(result.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token;x-amz-target/)
})
