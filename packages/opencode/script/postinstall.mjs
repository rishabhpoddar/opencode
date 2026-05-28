#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import childProcess from "child_process"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function detectPlatformAndArch() {
  // Map platform names
  let platform
  switch (os.platform()) {
    case "darwin":
      platform = "darwin"
      break
    case "linux":
      platform = "linux"
      break
    case "win32":
      platform = "windows"
      break
    default:
      platform = os.platform()
      break
  }

  // Map architecture names
  let arch
  switch (os.arch()) {
    case "x64":
      arch = "x64"
      break
    case "arm64":
      arch = "arm64"
      break
    case "arm":
      arch = "arm"
      break
    default:
      arch = os.arch()
      break
  }

  return { platform, arch }
}

function findBinary() {
  const { platform, arch } = detectPlatformAndArch()
  const packageName = `opencode-${platform}-${arch}`
  const binaryName = platform === "windows" ? "opencode.exe" : "opencode"

  try {
    // Use require.resolve to find the package
    const packageJsonPath = require.resolve(`${packageName}/package.json`)
    const packageDir = path.dirname(packageJsonPath)
    const binaryPath = path.join(packageDir, "bin", binaryName)

    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Binary not found at ${binaryPath}`)
    }

    return { binaryPath, binaryName }
  } catch (error) {
    throw new Error(`Could not find package ${packageName}: ${error.message}`)
  }
}

function supportsAvx2() {
  const { platform, arch } = detectPlatformAndArch()
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const cmd =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const exe of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const out = (result.stdout || "").trim().toLowerCase()
        if (out === "true" || out === "1") return true
        if (out === "false" || out === "0") return false
      } catch {
        continue
      }
    }

    return false
  }

  return false
}

function resolveBinaryPackageName() {
  const { platform, arch } = detectPlatformAndArch()
  const avx2 = supportsAvx2()
  const baseline = arch === "x64" && !avx2

  if (platform === "linux") {
    const musl = (() => {
      try {
        if (fs.existsSync("/etc/alpine-release")) return true
      } catch {
        // ignore
      }

      try {
        const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
        const text = ((result.stdout || "") + (result.stderr || "")).toLowerCase()
        if (text.includes("musl")) return true
      } catch {
        // ignore
      }

      return false
    })()

    if (musl) {
      if (arch === "x64") {
        if (baseline) return `opencode-${platform}-${arch}-baseline-musl`
        return `opencode-${platform}-${arch}-musl`
      }
      return `opencode-${platform}-${arch}-musl`
    }

    if (arch === "x64") {
      if (baseline) return `opencode-${platform}-${arch}-baseline`
      return `opencode-${platform}-${arch}`
    }
    return `opencode-${platform}-${arch}`
  }

  if (platform === "darwin") {
    if (arch === "x64" && baseline) return `opencode-${platform}-${arch}-baseline`
    return `opencode-${platform}-${arch}`
  }

  if (platform === "windows") {
    if (arch === "x64" && baseline) return `opencode-${platform}-${arch}-baseline`
    return `opencode-${platform}-${arch}`
  }

  return `opencode-${platform}-${arch}`
}

function extractTarball(tarballPath, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })

  const result = childProcess.spawnSync("tar", ["-xzf", tarballPath, "-C", targetDir, "--strip-components=1"], {
    stdio: "inherit",
  })
  if (result.status !== 0) {
    throw new Error(`Failed to extract ${path.basename(tarballPath)}`)
  }
}

function findEmbeddedTarball(packageName) {
  const matches = fs
    .readdirSync(__dirname)
    .filter((name) => name.startsWith(`${packageName}-`) && name.endsWith(".tgz"))

  if (matches.length === 0) {
    throw new Error(`Missing embedded tarball for ${packageName}`)
  }

  if (matches.length > 1) {
    throw new Error(`Found multiple embedded tarballs for ${packageName}: ${matches.join(", ")}`)
  }

  return path.join(__dirname, matches[0])
}

function main() {
  try {
    if (os.platform() === "win32") {
      // On Windows, the .exe is already included in the package and bin field points to it
      // No postinstall setup needed
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      return
    }

    const packageName = resolveBinaryPackageName()
    const tarballPath = findEmbeddedTarball(packageName)
    const installDir = path.join(__dirname, "node_modules", packageName)

    extractTarball(tarballPath, installDir)

    const { binaryPath } = findBinary()
    const target = path.join(__dirname, "bin", ".opencode")
    if (fs.existsSync(target)) fs.unlinkSync(target)
    try {
      fs.linkSync(binaryPath, target)
    } catch {
      fs.copyFileSync(binaryPath, target)
    }
    fs.chmodSync(target, 0o755)
  } catch (error) {
    console.error("Failed to setup opencode binary:", error.message)
    process.exit(1)
  }
}

main()
