import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const standaloneRoot = path.join(root, ".next", "standalone")

if (!existsSync(standaloneRoot)) {
  process.exit(0)
}

function copyIntoStandalone(source, destination) {
  if (!existsSync(source)) return
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true })
}

copyIntoStandalone(path.join(root, ".next", "static"), path.join(standaloneRoot, ".next", "static"))
copyIntoStandalone(path.join(root, "public"), path.join(standaloneRoot, "public"))

console.log("Copied standalone static assets.")
