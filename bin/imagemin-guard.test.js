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
      console.warn(`Skipping corrupt file: ${file}`)
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
    const originalStats = fs.readdirSync(testFolderGit).map(file => {
      const filePath = path.join(testFolderGit, file)
      return { file, stats: fs.statSync(filePath) }
    })
    execSync(`node "${imageminGuardScript}" --dry`)
    const newStats = fs.readdirSync(testFolderGit).map(file => {
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
    assert.strictEqual(/\bCompressed\b/.test(stdout) || /\bSkipped\b/.test(stdout), false)
  })

  test('Dry and quiet runs leave no artifacts and do not mutate files', () => {
    // Use isolated temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagemin-dry-quiet-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Snapshot sizes/mtimes
    const before = fs.readdirSync(tempTestFolder).map(file => {
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
    assert.strictEqual(/\bCompressed\b/.test(stdout) || /\bSkipped\b/.test(stdout), false)

    // Verify no mutations
    const after = fs.readdirSync(tempTestFolder).map(file => {
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