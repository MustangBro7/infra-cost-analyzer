import assert from "node:assert/strict"
import test from "node:test"

const AI_ROW_PATTERN = /\b(openai|anthropic|claude|chatgpt|codex|cursor|copilot|gemini|openrouter|llm|tokens?|prompts?|inference|lovable|bolt|replit)\b|\b(vertex\s+ai|workers\s+ai|ai\s+gateway|ai\s+sdk|vercel\s+ai|google\s+ai|model\s+usage)\b/i
const AWS_AI_ROW_PATTERN = /\b(bedrock|sagemaker|amazon\s+q|q\s+developer|rekognition|comprehend|textract|transcribe|translate|polly|lex|kendra)\b/i

test("AI row classifier does not treat AWS Lightsail as AI", () => {
  const text = "AWS Amazon Lightsail USD usage"
  assert.equal(AI_ROW_PATTERN.test(text), false)
  assert.equal(AWS_AI_ROW_PATTERN.test(text), false)
})

test("AI row classifier still catches explicit AI gateways and AWS AI services", () => {
  assert.equal(AI_ROW_PATTERN.test("Cloudflare AI Gateway token usage"), true)
  assert.equal(AI_ROW_PATTERN.test("Gemini model usage"), true)
  assert.equal(AWS_AI_ROW_PATTERN.test("Amazon Bedrock model inference"), true)
  assert.equal(AWS_AI_ROW_PATTERN.test("SageMaker endpoint"), true)
})
