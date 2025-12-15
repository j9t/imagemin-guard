import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert'
import simpleGit from 'simple-git'
import { fileTypes as allowedFileTypes } from '../src/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const testFolder = path.join(__dirname, '../media/test')
const testFolderGit = path.join(__dirname, '../media/test-git')
const imageminGuardScript = path.join(__dirname, '../bin/imagemin-guard.js')

// Function to copy files
function copyFiles(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
  }
  fs.readdirSync(srcDir).forEach(file => {
    const srcFile = path.join(srcDir, file)
    const destFile = path.join(destDir, file)
    fs.copyFileSync(srcFile, destFile)
  })
}

// Function to check if images are compressed
const ignoreFiles = ['test#corrupt.gif']

function areImagesCompressed(dir, originalDir = testFolder) {
  const uncompressedFiles = []
  const allCompressed = fs.readdirSync(dir).every(file => {
    if (ignoreFiles.includes(file)) {
      // console.info(`Ignoring file: ${file}`)
      return true
    }
    const ext = path.extname(file).slice(1).toLowerCase()
    if (!allowedFileTypes.includes(ext)) return true
    const filePath = path.join(dir, file)
    const originalFilePath = path.join(originalDir, file)
    try {
      const originalStats = fs.statSync(originalFilePath)
      const compressedStats = fs.statSync(filePath)
      const isCompressed = compressedStats.size < originalStats.size
      if (!isCompressed) {
        uncompressedFiles.push(file)
      }
      return isCompressed
    } catch (err) {
      console.warn(`Skipping possibly corrupt file: ${file} (${err.message})`)
      return true
    }
  })
  return { allCompressed, uncompressedFiles }
}

// Function to check if images are already compressed
function areImagesAlreadyCompressed(dir) {
  return fs.readdirSync(dir).some(file => {
    const ext = path.extname(file).slice(1).toLowerCase()
    if (!allowedFileTypes.includes(ext)) return false
    const filePath = path.join(dir, file)
    const originalFilePath = path.join(testFolder, file)
    const originalStats = fs.statSync(originalFilePath)
    const compressedStats = fs.statSync(filePath)
    return compressedStats.size >= originalStats.size
  })
}

describe('Imagemin Guard', () => {
  before(() => {
    // Back up original images
    copyFiles(testFolder, testFolderGit)
  })

  after(() => {
    // Clean up temporary directory
    if (fs.existsSync(testFolderGit)) {
      fs.rmSync(testFolderGit, { recursive: true, force: true })
    }
  })

  test('Compress images', () => {
    // Ensure images in temp folder are not already compressed
    assert.strictEqual(areImagesAlreadyCompressed(testFolderGit), true)

    // Run the script in a completely isolated temporary directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagemin-test-'))
    const tempTestFolder = path.join(tempDir, 'test')

    // Copy test files to isolated temp directory
    copyFiles(testFolder, tempTestFolder)

    // Run imagemin-guard from temp directory—only files in “tempDir” will be processed
    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execSync(`node "${imageminGuardScript}"`)
    } finally {
      process.chdir(originalCwd)
    }

    // Check results from the isolated temp files
    const { allCompressed, uncompressedFiles } = areImagesCompressed(tempTestFolder, testFolder)

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true })

    if (uncompressedFiles.length > 0) {
      console.log('The following files were not compressed:', uncompressedFiles.join(', '))
    }
    assert.strictEqual(allCompressed, true)
  })

  test('Compress only staged images', async () => {
    const git = simpleGit(testFolderGit)

    // Ensure the temp folder exists
    if (!fs.existsSync(testFolderGit)) {
      fs.mkdirSync(testFolderGit, { recursive: true })
    }

    // Initialize a temporary Git repository
    await git.init()
    await git.addConfig('user.name', 'Test User')
    await git.addConfig('user.email', 'test@example.com')

    // Stage files
    await git.add('.')

    // Run imagemin-guard script with “--staged” option
    execSync(`node "${imageminGuardScript}" --staged`, { cwd: testFolderGit })

    // Verify images are compressed
    const { allCompressed, uncompressedFiles } = areImagesCompressed(testFolderGit)
    if (uncompressedFiles.length > 0) {
      console.log('The following files were not compressed:', uncompressedFiles.join(', '))
    }
    assert.strictEqual(allCompressed, true)
  })

  test('Do not modify files in dry run', () => {
    const originalStats = fs.readdirSync(testFolderGit).sort().map(file => {
      const filePath = path.join(testFolderGit, file)
      return { file, stats: fs.statSync(filePath) }
    })
    execSync(`node "${imageminGuardScript}" --dry`, { cwd: testFolderGit, stdio: 'pipe' })
    const newStats = fs.readdirSync(testFolderGit).sort().map(file => {
      const filePath = path.join(testFolderGit, file)
      return { file, stats: fs.statSync(filePath) }
    })
    originalStats.forEach((original, index) => {
      const newFile = newStats[index]
      assert.strictEqual(newFile.file, original.file)
      assert.strictEqual(newFile.stats.size, original.stats.size)
      assert.strictEqual(newFile.stats.mtime.getTime(), original.stats.mtime.getTime())
    })
  })

  test('Ignore parity: single file (non-staged vs. staged)', async () => {
    // Prepare isolated temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagemin-ignore-one-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Pick a known file from fixture folder
    const entries = fs.readdirSync(tempTestFolder).filter(n => /\.(png|jpe?g|gif|webp|avif)$/i.test(n))
    if (entries.length === 0) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      return
    }
    const target = entries[0]
    const tempPath = path.join(tempTestFolder, target)
    // Snapshot the temp copy before running the CLI to ensure equality checks reflect true non-mutation
    const before = fs.statSync(tempPath)

    // Prepare a pre-run snapshot for non-ignored candidates to verify at least one gets compressed
    const preSnapshot = new Map()
    fs.readdirSync(tempTestFolder).sort().forEach(name => {
      if (name === target) return // excluded: explicitly ignored
      if (ignoreFiles.includes(name)) return // excluded: known corrupt fixture
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!allowedFileTypes.includes(ext)) return
      const p = path.join(tempTestFolder, name)
      preSnapshot.set(name, fs.statSync(p))
    })

    // Non-staged: Run with `--ignore=<file>`
    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execSync(`node "${imageminGuardScript}" --ignore=${path.posix.join('test', target)}`, { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    // Verify the ignored file was not modified (size and mtime unchanged vs. pre-run snapshot)
    const tempStats = fs.statSync(tempPath)
    assert.strictEqual(tempStats.size, before.size)
    assert.strictEqual(tempStats.mtime.getTime(), before.mtime.getTime())

    // Verify at least one non-ignored candidate was compressed in the non-staged run
    let shrunkCount = 0
    for (const [name, statBefore] of preSnapshot) {
      const statAfter = fs.statSync(path.join(tempTestFolder, name))
      if (statAfter.size < statBefore.size) shrunkCount++
    }
    assert.ok(shrunkCount >= 1, 'Expected at least one non-ignored file to be compressed')

    // Staged: Init repo, stage only target and another file, ensure ignore prevents its processing
    const git = simpleGit(tempTestFolder)
    await git.init()
    await git.addConfig('user.name', 'Test User')
    await git.addConfig('user.email', 'test@example.com')
    await git.add('.')

    // Run staged with `ignore`
    execSync(`node "${imageminGuardScript}" --staged --ignore=${path.posix.join('test', target)}`, { cwd: tempTestFolder, stdio: 'pipe' })

    // Check file still not modified compared to its current state (size should not shrink due to ignore)
    const afterStats = fs.statSync(tempPath)
    assert.strictEqual(afterStats.size, tempStats.size)

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Ignore supports multiple patterns and directories; case-insensitive', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagemin-ignore-multi-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Create a subdirectory to simulate directory ignore
    const subDir = path.join(tempTestFolder, 'Assets')
    fs.mkdirSync(subDir, { recursive: true })
    // Copy one file into subdir
    const oneFile = fs.readdirSync(tempTestFolder).find(n => /\.(png|jpe?g|gif|webp|avif)$/i.test(n))
    if (oneFile) fs.copyFileSync(path.join(tempTestFolder, oneFile), path.join(subDir, oneFile))

    // Build ignore list: specific file (if available) and directory (case-insensitive path)
    const ignoreArg = oneFile ? `--ignore=test/${oneFile},test/assets/` : `--ignore=test/assets/`
    // Snapshot the file placed in ignored directory, before running the CLI
    let preInside
    if (oneFile) {
      preInside = fs.statSync(path.join(subDir, oneFile))
    }

    // Snapshot before running CLI for file-level ignore check
    let preIgnored
    if (oneFile) {
      preIgnored = fs.statSync(path.join(tempTestFolder, oneFile))
    }

    // Build a pre-run snapshot of candidates that are not ignored
    const preSnapshot = new Map()
    fs.readdirSync(tempTestFolder).sort().forEach(name => {
      // Exclude the explicitly ignored file (if any) and anything inside the ignored directory
      if (oneFile && name === oneFile) return
      if (ignoreFiles.includes(name)) return // exclude corrupt fixture
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!allowedFileTypes.includes(ext)) return
      const p = path.join(tempTestFolder, name)
      preSnapshot.set(name, fs.statSync(p))
    })

    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execSync(`node "${imageminGuardScript}" ${ignoreArg}`, { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    // Assert ignored file unchanged (only if there was a file to ignore explicitly)
    if (oneFile) {
      const ignoredCopy = fs.statSync(path.join(tempTestFolder, oneFile))
      assert.strictEqual(ignoredCopy.size, preIgnored.size)
      assert.strictEqual(ignoredCopy.mtime.getTime(), preIgnored.mtime.getTime())
    }

    // Assert that at least one non-ignored file in the root `tempTestFolder` was compressed
    let shrunkCount = 0
    for (const [name, statBefore] of preSnapshot) {
      const statAfter = fs.statSync(path.join(tempTestFolder, name))
      if (statAfter.size < statBefore.size) shrunkCount++
    }
    assert.ok(shrunkCount >= 1, 'Expected at least one non-ignored file to be compressed')

    // Assert file inside ignored directory unchanged (if created)
    if (oneFile) {
      const inside = fs.statSync(path.join(subDir, oneFile))
      // Since original may change, assert that the file inside ignored directory remained unchanged, by comparing to its own pre-run snapshot
      assert.strictEqual(inside.size, preInside.size)
    }

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Quiet mode suppresses per-file logs but keeps summary', () => {
    // Prepare isolated temp directory with test images
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagemin-quiet-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const originalCwd = process.cwd()
    let stdout = ''
    try {
      process.chdir(tempDir)
      stdout = execSync(`node "${imageminGuardScript}" --quiet`, { encoding: 'utf8' })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }

    // Summary should be present
    assert.match(stdout, /Defensive base compression completed\./)
    // Per-file lines like “Compressed <file>” or “Skipped <file>” should be suppressed
    assert.strictEqual(!(/Compressed|Skipped/.test(stdout)), true)
  })

  test('Dry and quiet runs leave no artifacts and do not mutate files', () => {
    // Use isolated temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagemin-dry-quiet-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Snapshot sizes/mtimes
    const before = fs.readdirSync(tempTestFolder).sort().map(file => {
      const filePath = path.join(tempTestFolder, file)
      return { file, stats: fs.statSync(filePath) }
    })

    const originalCwd = process.cwd()
    let stdout = ''
    try {
      process.chdir(tempDir)
      stdout = execSync(`node "${imageminGuardScript}" --dry --quiet`, { encoding: 'utf8' })
    } finally {
      process.chdir(originalCwd)
    }

    // Summary present; no per-file lines
    assert.match(stdout, /There were no images to compress\.|Defensive base compression completed\./)
    assert.strictEqual(!(/Compressed|Skipped/.test(stdout)), true)

    // Verify no mutations
    const after = fs.readdirSync(tempTestFolder).sort().map(file => {
      const filePath = path.join(tempTestFolder, file)
      return { file, stats: fs.statSync(filePath) }
    })
    before.forEach((b, i) => {
      const a = after[i]
      assert.strictEqual(a.file, b.file)
      assert.strictEqual(a.stats.size, b.stats.size)
      assert.strictEqual(a.stats.mtime.getTime(), b.stats.mtime.getTime())
    })

    // Ensure no temp or backup artifacts present
    const entries = fs.readdirSync(tempTestFolder)
    const hasTemp = entries.some(name => name.startsWith('.imagemin-guard-'))
    const hasBak = entries.some(name => name.endsWith('.bak'))
    assert.strictEqual(hasTemp, false)
    assert.strictEqual(hasBak, false)

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('No .bak files remain after normal compression', () => {
    // Prepare isolated temp directory with test images
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagemin-bak-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execSync(`node "${imageminGuardScript}"`, { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    const entries = fs.readdirSync(tempTestFolder)
    const hasBak = entries.some(name => name.endsWith('.bak'))
    assert.strictEqual(hasBak, false)

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
})