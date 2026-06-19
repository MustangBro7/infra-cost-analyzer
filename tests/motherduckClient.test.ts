import assert from "node:assert/strict"
import test from "node:test"
import {
  motherDuckRegion,
  motherDuckStorageRate,
  parseMotherDuckSize,
  sanitizeMotherDuckConnectionString,
} from "../src/lib/motherduckClient"

test("MotherDuck size strings are normalized to bytes", () => {
  assert.equal(parseMotherDuckSize("3.0 MiB"), 3 * 1024 ** 2)
  assert.equal(parseMotherDuckSize("5.7 GiB"), Math.round(5.7 * 1024 ** 3))
  assert.equal(parseMotherDuckSize("0 bytes"), 0)
})

test("MotherDuck endpoints are restricted to verified PostgreSQL hosts", () => {
  const value = sanitizeMotherDuckConnectionString(
    "postgresql://postgres:token@pg.eu-central-1-aws.motherduck.com:5432/analytics?sslmode=require"
  )
  assert.match(value, /sslmode=verify-full/)
  assert.equal(motherDuckRegion(value), "eu-central-1-aws")
  assert.throws(
    () => sanitizeMotherDuckConnectionString("postgresql://postgres:token@example.com/db"),
    /MotherDuck account/
  )
})

test("MotherDuck storage rates follow the account region", () => {
  assert.equal(motherDuckStorageRate("us-east-1"), 0.04)
  assert.equal(motherDuckStorageRate("eu-central-1"), 0.043)
})
